import type { ApprovalDecision } from '../core/approvals.js';
import { artifactPage, type Artifact } from '../core/artifacts.js';
import { createAgentEvent, type AgentEvent } from '../core/events.js';
import { createRuntimeId } from '../core/ids.js';
import {
  createAgentSession,
  createInvocationRef,
  sessionRef,
  transitionAgentSession,
  type AgentRef,
  type AgentSession,
  type InvocationRef,
  type SessionRef,
} from '../core/sessions.js';
import type { AgentCapabilities, AgentProvider, AgentSpec, TaskSpec } from '../providers/agent.js';

export class FakeAgentProvider implements AgentProvider {
  readonly id: string;
  readonly approvalDecisions = new Map<string, ApprovalDecision>();
  readonly messages: readonly [string, string][] = [];
  private readonly sessions = new Map<string, AgentSession>();
  private readonly events = new Map<string, AgentEvent[]>();
  private readonly artifacts = new Map<string, Artifact[]>();

  constructor(id = 'fake-agent') {
    this.id = id;
  }

  capabilities(): AgentCapabilities {
    return {
      supports_streaming_events: true,
      supports_resume: true,
      supports_follow_up: true,
      supports_cancellation: true,
      supports_artifacts: true,
      supports_approvals: true,
      metadata: { fake: true },
    };
  }

  async createAgent(spec: AgentSpec): Promise<AgentRef> {
    return {
      provider: this.id,
      id: createRuntimeId('agent'),
      metadata: { name: spec.name, ...spec.metadata },
    };
  }

  async startSession(agent: AgentRef | string, task: TaskSpec): Promise<AgentSession> {
    const session = createAgentSession({
      provider: this.id,
      agent_id: typeof agent === 'string' ? agent : agent.id,
      task: task.input,
      status: 'running',
      metadata: task.metadata,
    });
    this.sessions.set(session.id, session);
    this.events.set(session.id, [
      createAgentEvent({
        type: 'session.started',
        session_id: session.id,
        provider: this.id,
      }),
    ]);
    return session;
  }

  async *streamEvents(
    session: SessionRef | AgentSession,
    options: { readonly after_event_id?: string } = {},
  ): AsyncIterable<AgentEvent> {
    const events = this.events.get(session.id) ?? [];
    const cursor =
      options.after_event_id === undefined
        ? -1
        : events.findIndex((event) => event.id === options.after_event_id);
    for (const event of events.slice(cursor + 1)) yield event;
  }

  async sendMessage(session: SessionRef | AgentSession, message: string): Promise<InvocationRef> {
    const mutable = this.messages as [string, string][];
    mutable.push([session.id, message]);
    return createInvocationRef(this.id, session.id, { metadata: { message } });
  }

  async resume(session: SessionRef | AgentSession): Promise<void> {
    const stored = this.sessions.get(session.id);
    if (stored !== undefined && stored.status !== 'running') {
      this.sessions.set(stored.id, transitionAgentSession(stored, 'running'));
    }
  }

  async approve(approvalId: string, decision: ApprovalDecision): Promise<void> {
    this.approvalDecisions.set(approvalId, decision);
  }

  async cancel(session: SessionRef | AgentSession): Promise<void> {
    const stored = this.sessions.get(session.id);
    if (stored !== undefined) {
      this.sessions.set(stored.id, transitionAgentSession(stored, 'cancelled'));
    }
  }

  async listArtifacts(
    session: SessionRef | AgentSession,
    options: { readonly type?: string; readonly after?: string; readonly limit?: number } = {},
  ) {
    let values = this.artifacts.get(session.id) ?? [];
    if (options.type !== undefined) values = values.filter((item) => item.type === options.type);
    const start =
      options.after === undefined
        ? 0
        : Math.max(0, values.findIndex((item) => item.id === options.after) + 1);
    const limit = options.limit ?? 100;
    const items = values.slice(start, start + limit);
    return artifactPage(items, {
      has_more: start + items.length < values.length,
      next_cursor: items.at(-1)?.id,
    });
  }

  queueEvent(session: SessionRef | AgentSession, event: AgentEvent): void {
    const events = this.events.get(session.id) ?? [];
    events.push(event);
    this.events.set(session.id, events);
  }

  addArtifact(session: SessionRef | AgentSession, artifact: Artifact): void {
    const artifacts = this.artifacts.get(session.id) ?? [];
    artifacts.push(artifact);
    this.artifacts.set(session.id, artifacts);
  }

  getSession(ref: SessionRef): AgentSession | undefined {
    return this.sessions.get(ref.id);
  }

  ref(session: AgentSession): SessionRef {
    return sessionRef(session);
  }
}
