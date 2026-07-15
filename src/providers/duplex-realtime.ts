import { AgentEventTypes, createAgentEvent, type AgentEvent } from '../core/events.js';
import { createRuntimeId } from '../core/ids.js';
import { createInvocationRef } from '../core/sessions.js';
import type {
  RealtimeCapabilities,
  RealtimeClientCommand,
  RealtimeConnectRequest,
  RealtimeProvider,
  RealtimeSessionConfig,
  RealtimeSessionRef,
} from './realtime.js';

export interface RealtimeDuplexTransport {
  readonly session_id?: string;
  send(command: RealtimeClientCommand): void | Promise<void>;
  events(): AsyncIterable<AgentEvent | Readonly<Record<string, unknown>>>;
  update?(config: RealtimeSessionConfig): void | Promise<void>;
  close(): void | Promise<void>;
}

export type RealtimeTransportFactory = (
  request: RealtimeConnectRequest,
) => RealtimeDuplexTransport | Promise<RealtimeDuplexTransport>;

abstract class DuplexRealtimeProvider implements RealtimeProvider {
  abstract readonly id: string;
  protected abstract readonly capabilityProfile: RealtimeCapabilities;
  private readonly sessions = new Map<string, RealtimeDuplexTransport>();

  constructor(private readonly factory: RealtimeTransportFactory) {}

  capabilities(): RealtimeCapabilities {
    return this.capabilityProfile;
  }

  async connect(request: RealtimeConnectRequest): Promise<RealtimeSessionRef> {
    const transport = await this.factory(request);
    const id = createRuntimeId('sess');
    this.sessions.set(id, transport);
    return {
      provider: this.id,
      id,
      model: request.model,
      transport: request.transport ?? 'websocket',
      provider_session_id: transport.session_id,
      provider_state: request.provider_state,
      metadata: request.metadata ?? {},
    };
  }

  async *streamEvents(session: RealtimeSessionRef): AsyncIterable<AgentEvent> {
    const transport = this.require(session.id);
    yield createAgentEvent({
      type: AgentEventTypes.REALTIME_SESSION_CONNECTED,
      session_id: session.id,
      provider: this.id,
      model: session.model,
    });
    for await (const value of transport.events()) {
      if (isAgentEvent(value)) {
        yield {
          ...value,
          session_id: value.session_id ?? session.id,
          provider: value.provider ?? this.id,
          raw: value.raw ?? value,
        };
      } else {
        yield createAgentEvent({
          type: readEventType(value),
          session_id: session.id,
          provider: this.id,
          model: session.model,
          data: value,
          raw: value,
        });
      }
    }
  }

  async send(session: RealtimeSessionRef, command: RealtimeClientCommand) {
    await this.require(session.id).send(command);
    return createInvocationRef(this.id, session.id, { metadata: { command_type: command.type } });
  }

  async updateSession(session: RealtimeSessionRef, config: RealtimeSessionConfig): Promise<void> {
    await this.require(session.id).update?.(config);
  }

  async close(session?: RealtimeSessionRef): Promise<void> {
    if (session !== undefined) {
      const transport = this.sessions.get(session.id);
      this.sessions.delete(session.id);
      await transport?.close();
      return;
    }
    await Promise.all([...this.sessions.values()].map(async (transport) => transport.close()));
    this.sessions.clear();
  }

  private require(id: string): RealtimeDuplexTransport {
    const transport = this.sessions.get(id);
    if (transport === undefined) throw new Error(`Realtime session '${id}' was not found.`);
    return transport;
  }
}

export class OpenAIRealtimeProvider extends DuplexRealtimeProvider {
  readonly id = 'openai-realtime';
  protected readonly capabilityProfile: RealtimeCapabilities = {
    input_modalities: ['text', 'audio', 'image'],
    output_modalities: ['text', 'audio'],
    transports: ['websocket', 'webrtc'],
    supports_tools: true,
    supports_resume: false,
    metadata: { adapter: 'injected_duplex', experimental: true },
  };
}

export class GeminiLiveProvider extends DuplexRealtimeProvider {
  readonly id = 'gemini-live';
  protected readonly capabilityProfile: RealtimeCapabilities = {
    input_modalities: ['text', 'audio', 'image', 'video'],
    output_modalities: ['text', 'audio'],
    transports: ['websocket'],
    supports_tools: true,
    supports_resume: false,
    metadata: { adapter: 'injected_duplex', experimental: true },
  };
}

export class DeterministicDuplexTransport implements RealtimeDuplexTransport {
  readonly commands: RealtimeClientCommand[] = [];
  readonly updates: RealtimeSessionConfig[] = [];
  closed = false;
  constructor(
    private readonly scriptedEvents: readonly (
      | AgentEvent
      | Readonly<Record<string, unknown>>
    )[] = [],
    readonly session_id = 'deterministic',
  ) {}
  send(command: RealtimeClientCommand): void {
    this.commands.push(command);
  }
  async *events() {
    for (const event of this.scriptedEvents) yield event;
  }
  update(config: RealtimeSessionConfig): void {
    this.updates.push(config);
  }
  close(): void {
    this.closed = true;
  }
}

function isAgentEvent(value: unknown): value is AgentEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    'type' in value &&
    'timestamp' in value &&
    'data' in value
  );
}

function readEventType(value: Readonly<Record<string, unknown>>): string {
  const type = value.type;
  return typeof type === 'string' ? type : AgentEventTypes.REALTIME_SESSION_UPDATED;
}
