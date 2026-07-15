import type { ApprovalDecision, ApprovalRequest } from '../core/approvals.js';
import type { Artifact } from '../core/artifacts.js';
import { SessionNotFoundError, UnsupportedFeatureError } from '../core/errors.js';
import { AgentEventTypes, type AgentEvent } from '../core/events.js';
import type { AgentSessionResult, AgentSessionResultStatus } from '../core/results.js';
import {
  sessionRef,
  transitionAgentSession,
  type AgentRef,
  type AgentSession,
  type InvocationRef,
  type SessionRef,
} from '../core/sessions.js';
import type { SessionSnapshot, SessionStore } from '../persistence/stores.js';
import { createSessionSnapshot, InMemorySessionStore } from '../persistence/stores.js';
import type { AgentSpec, TaskSpec } from '../providers/agent.js';
import { ProviderRegistry } from '../providers/registry.js';

export class AgentSessionsRuntime {
  private readonly idempotentInvocations = new Map<string, InvocationRef>();

  constructor(
    readonly registry: ProviderRegistry,
    private readonly store: SessionStore = new InMemorySessionStore(),
  ) {}

  createAgent(provider: string, spec: AgentSpec): Promise<AgentRef> {
    return this.registry.getAgentProvider(provider).createAgent(spec);
  }

  async start(provider: string, agent: AgentRef | string, task: TaskSpec): Promise<AgentSession> {
    const session = await this.registry.getAgentProvider(provider).startSession(agent, task);
    await this.store.save(createSessionSnapshot(session));
    return session;
  }

  async *stream(
    session: SessionRef | AgentSession,
    options: { readonly after_event_id?: string } = {},
  ): AsyncIterable<AgentEvent> {
    let snapshot = await this.requireSnapshot(session.id);
    const stored = eventsAfter(snapshot.events, options.after_event_id);
    for (const event of stored) yield event;
    if (isTerminal(snapshot.session.status)) return;

    const after = stored.at(-1)?.id ?? options.after_event_id;
    const provider = this.registry.getAgentProvider(snapshot.session.provider);
    for await (const event of provider.streamEvents(session, { after_event_id: after })) {
      // Approval decisions can be persisted by a consumer while this generator is
      // suspended at an approval event. Refresh before appending the next provider
      // event so the stream cannot overwrite that concurrent durable decision.
      snapshot = (await this.store.load(session.id)) ?? snapshot;
      if (snapshot.events.some((storedEvent) => storedEvent.id === event.id)) continue;
      const stamped = { ...event, session_id: event.session_id ?? session.id };
      const approvalRequest = readApprovalRequest(stamped.data.request);
      const providerState = readProviderState(stamped.data.provider_state);
      snapshot = {
        ...snapshot,
        session: transitionFromEvent(snapshot.session, stamped),
        events: [...snapshot.events, stamped],
        approvals:
          approvalRequest === undefined
            ? snapshot.approvals
            : {
                ...snapshot.approvals,
                [approvalRequest.id]: { request: approvalRequest },
              },
        provider_state: providerState ?? snapshot.provider_state,
      };
      await this.store.save(snapshot);
      yield stamped;
    }
  }

  async run<T = string>(session: SessionRef | AgentSession): Promise<AgentSessionResult<T>> {
    const events: AgentEvent[] = [];
    for await (const event of this.stream(session)) events.push(event);
    const snapshot = await this.requireSnapshot(session.id);
    const artifacts = await this.listAllArtifacts(snapshot.session);
    const messages = events
      .filter((event) => event.type === AgentEventTypes.AGENT_RESPONSE_MESSAGE_CREATED)
      .map((event, index) => ({
        role: 'assistant' as const,
        index,
        content: typeof event.data.content === 'string' ? event.data.content : '',
        metadata: event.data,
      }));
    const completion = [...events]
      .reverse()
      .find(
        (event) =>
          event.type === AgentEventTypes.SESSION_COMPLETED ||
          event.type === AgentEventTypes.RUN_COMPLETED,
      );
    const text =
      typeof completion?.data.text === 'string'
        ? completion.data.text
        : (messages.at(-1)?.content ?? '');
    return {
      output: (completion?.data.output ?? text) as T,
      text,
      session_ref: sessionRef(snapshot.session),
      status: resultStatus(snapshot.session.status),
      events,
      messages,
      artifacts,
      provider_state: snapshot.provider_state,
      trace: { trace_id: events.find((event) => event.trace_id !== undefined)?.trace_id },
      metadata: snapshot.metadata,
    };
  }

  async sendMessage(
    session: SessionRef | AgentSession,
    message: string,
    options: { readonly idempotency_key?: string } = {},
  ): Promise<InvocationRef> {
    const key = options.idempotency_key;
    const cacheKey = key === undefined ? undefined : `${session.provider}:${session.id}:${key}`;
    if (cacheKey !== undefined) {
      const existing = this.idempotentInvocations.get(cacheKey);
      if (existing !== undefined) return existing;
    }
    const provider = this.registry.getAgentProvider(session.provider);
    const invocation = await provider.sendMessage(session, message, options);
    if (cacheKey !== undefined) this.idempotentInvocations.set(cacheKey, invocation);
    const snapshot = await this.requireSnapshot(session.id);
    await this.store.save({
      ...snapshot,
      invocations: [...snapshot.invocations, invocation],
    });
    return invocation;
  }

  async approve(
    session: SessionRef | AgentSession,
    approvalId: string,
    decision: ApprovalDecision,
  ): Promise<void> {
    const provider = this.registry.getAgentProvider(session.provider);
    if (!provider.capabilities().supports_approvals) {
      throw new UnsupportedFeatureError('agent_approvals');
    }
    await provider.approve(approvalId, decision);
    const snapshot = await this.requireSnapshot(session.id);
    const record = snapshot.approvals[approvalId];
    if (record !== undefined) {
      await this.store.save({
        ...snapshot,
        approvals: { ...snapshot.approvals, [approvalId]: { ...record, decision } },
      });
    }
  }

  async cancel(session: SessionRef | AgentSession): Promise<void> {
    const provider = this.registry.getAgentProvider(session.provider);
    if (!provider.capabilities().supports_cancellation) {
      throw new UnsupportedFeatureError('agent_cancellation');
    }
    await provider.cancel(session);
  }

  async resume(session: SessionRef | AgentSession): Promise<void> {
    const provider = this.registry.getAgentProvider(session.provider);
    if (!provider.capabilities().supports_resume) throw new UnsupportedFeatureError('agent_resume');
    await provider.resume?.(session);
  }

  replay(sessionId: string): Promise<SessionSnapshot> {
    return this.requireSnapshot(sessionId);
  }

  private async listAllArtifacts(session: AgentSession): Promise<readonly Artifact[]> {
    const provider = this.registry.getAgentProvider(session.provider);
    if (!provider.capabilities().supports_artifacts) return [];
    const result: Artifact[] = [];
    let cursor: string | undefined;
    do {
      const page = await provider.listArtifacts(session, { after: cursor, limit: 100 });
      result.push(...page.items);
      cursor = page.has_more ? page.next_cursor : undefined;
    } while (cursor !== undefined);
    return result;
  }

  private async requireSnapshot(sessionId: string): Promise<SessionSnapshot> {
    const snapshot = await this.store.load(sessionId);
    if (snapshot === undefined) {
      throw new SessionNotFoundError(`Session '${sessionId}' was not found.`, {
        session_id: sessionId,
        operation: 'agents.session',
      });
    }
    return snapshot;
  }
}

function eventsAfter(
  events: readonly AgentEvent[],
  cursor: string | undefined,
): readonly AgentEvent[] {
  if (cursor === undefined) return events;
  const index = events.findIndex((event) => event.id === cursor);
  return index < 0 ? [] : events.slice(index + 1);
}

function transitionFromEvent(session: AgentSession, event: AgentEvent): AgentSession {
  if (
    event.type === AgentEventTypes.SESSION_COMPLETED ||
    event.type === AgentEventTypes.RUN_COMPLETED
  ) {
    return transitionAgentSession(
      session.status === 'waiting' ? { ...session, status: 'running' } : session,
      'completed',
    );
  }
  if (event.type === AgentEventTypes.SESSION_FAILED || event.type === AgentEventTypes.RUN_FAILED) {
    return transitionAgentSession(session, 'failed');
  }
  if (event.type === AgentEventTypes.SESSION_CANCELLED) {
    return transitionAgentSession(session, 'cancelled');
  }
  if (event.type === AgentEventTypes.APPROVAL_REQUESTED) {
    return transitionAgentSession(session, 'waiting');
  }
  if (
    session.status === 'waiting' &&
    (event.type === AgentEventTypes.APPROVAL_APPROVED ||
      event.type === AgentEventTypes.APPROVAL_DENIED)
  ) {
    return transitionAgentSession(session, 'running');
  }
  return session;
}

function isTerminal(status: AgentSession['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function resultStatus(status: AgentSession['status']): AgentSessionResultStatus {
  if (status === 'waiting') return 'waiting_for_approval';
  return status === 'created' || status === 'running' ? 'timeout' : status;
}

function readApprovalRequest(value: unknown): ApprovalRequest | undefined {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('id' in value) ||
    typeof value.id !== 'string' ||
    !('action' in value) ||
    typeof value.action !== 'string'
  ) {
    return undefined;
  }
  return value as ApprovalRequest;
}

function readProviderState(value: unknown): SessionSnapshot['provider_state'] {
  return typeof value === 'object' &&
    value !== null &&
    'provider' in value &&
    typeof value.provider === 'string'
    ? (value as NonNullable<SessionSnapshot['provider_state']>)
    : undefined;
}
