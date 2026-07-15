import { ApprovalManager, type ApprovalDecision } from '../core/approvals.js';
import { artifactPage, type Artifact } from '../core/artifacts.js';
import { AgentEventTypes, createAgentEvent, type AgentEvent } from '../core/events.js';
import { createRuntimeId } from '../core/ids.js';
import {
  createAgentSession,
  createInvocationRef,
  transitionAgentSession,
  type AgentRef,
  type AgentSession,
  type InvocationRef,
  type SessionRef,
} from '../core/sessions.js';
import type { AgentRunRequest } from '../runtime/agent-loop.js';
import type { AgentRuntime } from '../runtime/agent-runtime.js';
import type { AgentCapabilities, AgentProvider, AgentSpec, TaskSpec } from './agent.js';

interface LocalAgentRecord {
  readonly ref: AgentRef;
  readonly spec: AgentSpec;
}

interface LocalSessionRecord {
  session: AgentSession;
  readonly agent: LocalAgentRecord;
  readonly events: AgentEvent[];
  readonly artifacts: Artifact[];
  readonly approvals: ApprovalManager;
  readonly abort: AbortController;
  readonly eventWaiters: Set<() => void>;
  done: boolean;
  job: Promise<void>;
}

export class LocalAgentProvider implements AgentProvider {
  readonly id = 'local';
  private readonly agents = new Map<string, LocalAgentRecord>();
  private readonly sessions = new Map<string, LocalSessionRecord>();
  private readonly approvalToSession = new Map<string, string>();
  private readonly invocations = new Map<string, InvocationRef>();

  constructor(private readonly runtime: AgentRuntime) {}

  capabilities(): AgentCapabilities {
    return {
      supports_streaming_events: true,
      supports_resume: true,
      supports_follow_up: true,
      supports_cancellation: true,
      supports_artifacts: true,
      supports_approvals: true,
      metadata: { runtime: 'agent_loop' },
    };
  }

  async createAgent(spec: AgentSpec): Promise<AgentRef> {
    const ref = {
      provider: this.id,
      id: createRuntimeId('agent'),
      metadata: { name: spec.name, ...spec.metadata },
    };
    this.agents.set(ref.id, { ref, spec });
    return ref;
  }

  async startSession(agent: AgentRef | string, task: TaskSpec): Promise<AgentSession> {
    const agentId = typeof agent === 'string' ? agent : agent.id;
    const record = this.agents.get(agentId);
    if (record === undefined) throw new Error(`Local agent '${agentId}' was not found.`);
    const session = createAgentSession({
      provider: this.id,
      agent_id: agentId,
      model: record.spec.model,
      task: task.input,
      status: 'running',
      metadata: task.metadata,
    });
    const local: LocalSessionRecord = {
      session,
      agent: record,
      events: [
        createAgentEvent({
          type: AgentEventTypes.SESSION_STARTED,
          session_id: session.id,
          provider: this.id,
          trace_id: task.trace_id,
        }),
      ],
      artifacts: [],
      approvals: new ApprovalManager(),
      abort: new AbortController(),
      eventWaiters: new Set(),
      done: false,
      job: Promise.resolve(),
    };
    this.sessions.set(session.id, local);
    local.job = this.execute(local, task.input, task.trace_id);
    return session;
  }

  async *streamEvents(
    session: SessionRef | AgentSession,
    options: { readonly after_event_id?: string } = {},
  ): AsyncIterable<AgentEvent> {
    const record = this.requireSession(session.id);
    const cursor =
      options.after_event_id === undefined
        ? -1
        : record.events.findIndex((event) => event.id === options.after_event_id);
    let index = cursor + 1;
    while (true) {
      while (index < record.events.length) {
        const event = record.events[index];
        index += 1;
        if (event !== undefined) yield event;
      }
      if (record.done) return;
      await new Promise<void>((resolve) => record.eventWaiters.add(resolve));
    }
  }

  async sendMessage(
    session: SessionRef | AgentSession,
    message: string,
    options: { readonly idempotency_key?: string } = {},
  ): Promise<InvocationRef> {
    const key = options.idempotency_key;
    const cacheKey = key === undefined ? undefined : `${session.id}:${key}`;
    if (cacheKey !== undefined) {
      const existing = this.invocations.get(cacheKey);
      if (existing !== undefined) return existing;
    }
    const record = this.requireSession(session.id);
    if (record.session.status === 'completed') {
      record.session = { ...record.session, status: 'running' };
    }
    const invocation = createInvocationRef(this.id, session.id, { metadata: { message } });
    if (cacheKey !== undefined) this.invocations.set(cacheKey, invocation);
    record.done = false;
    record.job = this.execute(record, message);
    return invocation;
  }

  async approve(approvalId: string, decision: ApprovalDecision): Promise<void> {
    const sessionId = this.approvalToSession.get(approvalId);
    if (sessionId === undefined) throw new Error(`Approval '${approvalId}' was not found.`);
    this.requireSession(sessionId).approvals.decide(approvalId, decision);
  }

  async cancel(session: SessionRef | AgentSession): Promise<void> {
    const record = this.requireSession(session.id);
    record.abort.abort(new Error('Session cancelled.'));
    if (record.session.status === 'running' || record.session.status === 'waiting') {
      record.session = transitionAgentSession(record.session, 'cancelled');
      this.appendEvent(
        record,
        createAgentEvent({
          type: AgentEventTypes.SESSION_CANCELLED,
          session_id: session.id,
          provider: this.id,
        }),
      );
    }
  }

  async resume(session: SessionRef | AgentSession): Promise<void> {
    await this.requireSession(session.id).job;
  }

  async listArtifacts(
    session: SessionRef | AgentSession,
    options: { readonly type?: string; readonly after?: string; readonly limit?: number } = {},
  ) {
    let artifacts = this.requireSession(session.id).artifacts;
    if (options.type !== undefined)
      artifacts = artifacts.filter((item) => item.type === options.type);
    const start =
      options.after === undefined
        ? 0
        : artifacts.findIndex((item) => item.id === options.after) + 1;
    const items = artifacts.slice(Math.max(0, start), Math.max(0, start) + (options.limit ?? 100));
    return artifactPage(items, {
      has_more: start + items.length < artifacts.length,
      next_cursor: items.at(-1)?.id,
    });
  }

  private async execute(
    record: LocalSessionRecord,
    input: string,
    traceId?: string,
  ): Promise<void> {
    record.done = false;
    try {
      const request: AgentRunRequest = {
        ...(record.agent.spec.metadata?.run_request as Partial<AgentRunRequest> | undefined),
        model: record.agent.spec.model ?? 'fake:fake-model',
        instructions: record.agent.spec.instructions,
        input,
        session_id: record.session.id,
        approval_manager: record.approvals,
        signal: record.abort.signal,
        trace_id: traceId ?? createRuntimeId('run'),
      };
      for await (const event of this.runtime.stream(request)) {
        this.appendEvent(record, { ...event, session_id: record.session.id });
        if (event.type === AgentEventTypes.APPROVAL_REQUESTED) {
          const approval = event.data.request;
          if (
            typeof approval === 'object' &&
            approval !== null &&
            'id' in approval &&
            typeof approval.id === 'string'
          ) {
            this.approvalToSession.set(approval.id, record.session.id);
          }
          record.session = transitionAgentSession(record.session, 'waiting');
        }
        if (event.type === AgentEventTypes.RUN_COMPLETED) {
          record.session = transitionAgentSession(
            record.session.status === 'waiting'
              ? { ...record.session, status: 'running' }
              : record.session,
            'completed',
          );
          record.artifacts.push(...readArtifacts(event.data.artifacts));
          this.appendEvent(
            record,
            createAgentEvent({
              type: AgentEventTypes.SESSION_COMPLETED,
              session_id: record.session.id,
              provider: this.id,
              trace_id: event.trace_id,
              data: event.data,
            }),
          );
        }
      }
    } catch (cause) {
      if (record.session.status === 'cancelled') return;
      record.session = transitionAgentSession(
        record.session.status === 'waiting'
          ? { ...record.session, status: 'running' }
          : record.session,
        'failed',
      );
      this.appendEvent(
        record,
        createAgentEvent({
          type: AgentEventTypes.SESSION_FAILED,
          session_id: record.session.id,
          provider: this.id,
          data: { error: cause instanceof Error ? cause.message : 'Unknown local-agent failure.' },
        }),
      );
    } finally {
      record.done = true;
      this.notifyEventWaiters(record);
    }
  }

  private appendEvent(record: LocalSessionRecord, event: AgentEvent): void {
    record.events.push(event);
    this.notifyEventWaiters(record);
  }

  private notifyEventWaiters(record: LocalSessionRecord): void {
    for (const resolve of record.eventWaiters) resolve();
    record.eventWaiters.clear();
  }

  private requireSession(sessionId: string): LocalSessionRecord {
    const record = this.sessions.get(sessionId);
    if (record === undefined) throw new Error(`Local session '${sessionId}' was not found.`);
    return record;
  }
}

function readArtifacts(value: unknown): Artifact[] {
  return Array.isArray(value) ? (value as Artifact[]) : [];
}
