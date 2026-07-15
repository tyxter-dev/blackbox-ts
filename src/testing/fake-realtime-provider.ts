import { AgentEventTypes, createAgentEvent, type AgentEvent } from '../core/events.js';
import { createAgentSession, createInvocationRef } from '../core/sessions.js';
import type {
  RealtimeCapabilities,
  RealtimeClientCommand,
  RealtimeConnectRequest,
  RealtimeProvider,
  RealtimeSessionConfig,
  RealtimeSessionRef,
} from '../providers/realtime.js';

export class FakeRealtimeProvider implements RealtimeProvider {
  readonly id: string;
  readonly commands: RealtimeClientCommand[] = [];
  readonly updates: RealtimeSessionConfig[] = [];
  readonly connections: RealtimeConnectRequest[] = [];
  private readonly events = new Map<string, AgentEvent[]>();

  constructor(id = 'fake-realtime') {
    this.id = id;
  }

  capabilities(): RealtimeCapabilities {
    return {
      input_modalities: ['text', 'audio', 'image'],
      output_modalities: ['text', 'audio'],
      transports: ['websocket'],
      supports_tools: true,
      supports_resume: true,
      metadata: { fake: true },
    };
  }

  async connect(request: RealtimeConnectRequest): Promise<RealtimeSessionRef> {
    this.connections.push(request);
    const session = createAgentSession({
      provider: this.id,
      model: request.model,
      task: 'realtime',
      status: 'running',
      metadata: request.metadata,
    });
    const ref: RealtimeSessionRef = {
      provider: this.id,
      id: session.id,
      model: request.model,
      transport: request.transport ?? 'websocket',
      provider_state: request.provider_state,
      metadata: session.metadata,
    };
    this.events.set(ref.id, [
      createAgentEvent({
        type: AgentEventTypes.REALTIME_SESSION_CONNECTED,
        session_id: ref.id,
        provider: this.id,
      }),
    ]);
    return ref;
  }

  async *streamEvents(
    session: RealtimeSessionRef,
    options: { readonly after_event_id?: string } = {},
  ): AsyncIterable<AgentEvent> {
    const events = this.events.get(session.id) ?? [];
    const cursor =
      options.after_event_id === undefined
        ? -1
        : events.findIndex((event) => event.id === options.after_event_id);
    for (const event of events.slice(cursor + 1)) yield event;
  }

  async send(session: RealtimeSessionRef, command: RealtimeClientCommand) {
    this.commands.push(command);
    return createInvocationRef(this.id, session.id, { metadata: { command_type: command.type } });
  }

  async updateSession(_session: RealtimeSessionRef, config: RealtimeSessionConfig): Promise<void> {
    this.updates.push(config);
  }

  close(): void {}

  queueEvent(session: RealtimeSessionRef, event: AgentEvent): void {
    const events = this.events.get(session.id) ?? [];
    events.push(event);
    this.events.set(session.id, events);
  }
}
