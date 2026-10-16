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
import {
  activePermissions,
  permissionBoundary,
  permissionBoundaryIterator,
  validatePackageModelConfig,
  type PackagePermissions,
} from '../core/tool-permissions.js';
import type { AgentRunRequest } from '../runtime/agent-loop.js';
import type { AgentRuntime } from '../runtime/agent-runtime.js';
import { registerLocalSessionLookup } from './local-agent-state.js';
import type { AgentCapabilities, AgentProvider, AgentSpec, TaskSpec } from './agent.js';

interface LocalAgentRecord {
  readonly ref: AgentRef;
  readonly spec: AgentSpec;
  /** The package boundary this agent was created inside, snapshotted there. */
  readonly permissions: readonly PackagePermissions[];
}

interface LocalSessionRecord {
  session: AgentSession;
  readonly agent: LocalAgentRecord;
  readonly events: AgentEvent[];
  readonly artifacts: Artifact[];
  readonly approvals: ApprovalManager;
  /** The agent's snapshot composed with the boundary this session started inside. */
  readonly permissions: readonly PackagePermissions[];
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

  constructor(private readonly runtime: AgentRuntime) {
    registerLocalSessionLookup(this, (sessionId) => this.sessions.has(sessionId));
  }

  capabilities(): AgentCapabilities {
    return {
      supports_streaming_events: true,
      supports_resume: true,
      supports_follow_up: true,
      supports_cancellation: true,
      supports_artifacts: true,
      supports_approvals: true,
      supports_package_permissions: true,
      metadata: { runtime: 'agent_loop' },
    };
  }

  /**
   * Create an agent and snapshot the boundary it was created inside.
   *
   * The hosted configuration is validated first, so a package whose hosted
   * tools cannot be enforced fails before this provider holds any record of
   * the agent ((parent) src/blackbox/providers/agent_adapters/local.py L69-131).
   * Local agents carry their run request in `spec.metadata.run_request`, which
   * is where hosted tools reach the loop in this port.
   */
  async createAgent(spec: AgentSpec): Promise<AgentRef> {
    validatePackageModelConfig(runRequestOf(spec)?.hosted_tools ?? [], {});
    const ref = {
      provider: this.id,
      id: createRuntimeId('agent'),
      metadata: { name: spec.name, ...spec.metadata },
    };
    this.agents.set(ref.id, { ref, spec, permissions: activePermissions() });
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
      permissions: [...record.permissions, ...activePermissions()],
      abort: new AbortController(),
      eventWaiters: new Set(),
      done: false,
      job: Promise.resolve(),
    };
    this.sessions.set(session.id, local);
    local.job = this.execute(local, task.input, task.trace_id);
    return session;
  }

  /**
   * Stream one session's events, re-entering the session's stored permissions
   * around every step.
   *
   * A consumer that pulls this generator from outside the boundary resumes it
   * in its own context, so the stored snapshot has to be re-entered here
   * ((parent) local.py L107-131). In this port the stream only replays the
   * events `execute` recorded and makes no permission decision of its own, so
   * the re-entry is defensive and parent-shaped: enforcement lives in
   * `execute`, which runs the loop eagerly under the composed boundary. The
   * runtime facade already re-enters the caller's own boundary, so with
   * nothing stored the inner generator is returned untouched rather than
   * wrapped a second time.
   */
  streamEvents(
    session: SessionRef | AgentSession,
    options: { readonly after_event_id?: string } = {},
  ): AsyncIterable<AgentEvent> {
    const record = this.requireSession(session.id);
    if (record.permissions.length === 0) return this.streamSessionEvents(record, options);
    const permissions = [...activePermissions(), ...record.permissions];
    const source = this.streamSessionEvents(record, options);
    return permissionBoundaryIterator(permissions, source[Symbol.asyncIterator]());
  }

  private async *streamSessionEvents(
    record: LocalSessionRecord,
    options: { readonly after_event_id?: string } = {},
  ): AsyncGenerator<AgentEvent> {
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

  /**
   * Run one invocation of a session inside the caller's boundary composed with
   * that session's stored permissions.
   *
   * The job is started by `startSession`/`sendMessage`, which a host may call
   * from outside the boundary the session was created in, or from inside a
   * narrower one. The parent runs its loop under
   * `(*active_permissions(), *permissions)` ((parent) local.py L107-131), so
   * both frames decide here: a stored snapshot keeps the loop enforced when the
   * caller holds no boundary, and an ambient boundary narrower than the
   * snapshot is never widened by it. Only when both are empty does the loop
   * run unwrapped.
   */
  private execute(record: LocalSessionRecord, input: string, traceId?: string): Promise<void> {
    const permissions = [...activePermissions(), ...record.permissions];
    return permissions.length === 0
      ? this.executeRun(record, input, traceId)
      : permissionBoundary(permissions, () => this.executeRun(record, input, traceId));
  }

  private async executeRun(
    record: LocalSessionRecord,
    input: string,
    traceId?: string,
  ): Promise<void> {
    record.done = false;
    try {
      const request: AgentRunRequest = {
        ...runRequestOf(record.agent.spec),
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
        // An in-flight run may still emit diagnostics after cancellation. Keep
        // those events without reopening the session or publishing completion.
        if (record.session.status === 'cancelled') continue;
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

/**
 * The partial run request a host attached to an agent spec. It is the only
 * channel through which a local agent receives tools, hosted tools, or a
 * workspace in this port.
 */
function runRequestOf(spec: AgentSpec): Partial<AgentRunRequest> | undefined {
  const request = spec.metadata?.run_request;
  return typeof request === 'object' && request !== null ? request : undefined;
}

function readArtifacts(value: unknown): Artifact[] {
  return Array.isArray(value) ? (value as Artifact[]) : [];
}
