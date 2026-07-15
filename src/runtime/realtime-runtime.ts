import { RealtimeSessionError, RealtimeUnsupportedFeatureError } from '../core/errors.js';
import { AgentEventTypes, createAgentEvent, type AgentEvent } from '../core/events.js';
import { parseProviderModelRef } from '../core/refs.js';
import type { InvocationRef } from '../core/sessions.js';
import type {
  RealtimeClientCommand,
  RealtimeConnectRequest,
  RealtimeProvider,
  RealtimeSessionConfig,
  RealtimeSessionRef,
} from '../providers/realtime.js';
import { ProviderRegistry } from '../providers/registry.js';

export class RealtimeRuntime {
  constructor(readonly registry: ProviderRegistry) {}

  async connect(request: RealtimeConnectRequest): Promise<ManagedRealtimeSession> {
    const configured = request.runtime_config?.toValues({ surface: 'realtime' }) ?? {};
    const configuredRef = readString(configured.provider) ?? readString(configured.model);
    const modelRef = request.model ?? configuredRef;
    if (modelRef === undefined) {
      throw new RealtimeSessionError('Realtime connection requires a provider:model ref.', {
        code: 'model_required',
      });
    }
    const parsed = parseProviderModelRef(modelRef);
    const provider = this.registry.getRealtimeProvider(parsed.provider);
    const capabilities = provider.capabilities(parsed.model);
    const transport =
      request.transport ?? readTransport(configured.transport) ?? capabilities.transports[0];
    if (transport === undefined || !capabilities.transports.includes(transport)) {
      throw new RealtimeUnsupportedFeatureError(
        `Realtime transport '${String(transport)}' is unsupported.`,
      );
    }
    const profileConfig = readRealtimeConfig(configured.realtime_session);
    const sessionConfig = { ...profileConfig, ...request.config };
    for (const modality of sessionConfig.input_modalities ?? []) {
      if (!capabilities.input_modalities.includes(modality)) {
        throw new RealtimeUnsupportedFeatureError(
          `Realtime input modality '${modality}' is unsupported.`,
        );
      }
    }
    for (const modality of sessionConfig.output_modalities ?? []) {
      if (!capabilities.output_modalities.includes(modality)) {
        throw new RealtimeUnsupportedFeatureError(
          `Realtime output modality '${modality}' is unsupported.`,
        );
      }
    }
    if ((request.tools?.length ?? 0) > 0 && !capabilities.supports_tools) {
      throw new RealtimeUnsupportedFeatureError('Realtime tools are unsupported.');
    }
    const providerRequest: RealtimeConnectRequest = {
      ...request,
      model: parsed.model,
      runtime_config: undefined,
      config: sessionConfig,
      transport,
      tool_mode: request.tool_mode ?? readToolMode(configured.tool_mode),
    };
    const ref = await provider.connect(providerRequest);
    return new ManagedRealtimeSession(provider, ref, {
      ...providerRequest,
      model: modelRef,
    });
  }

  async reconnect(session: ManagedRealtimeSession): Promise<ManagedRealtimeSession> {
    if (!session.provider.capabilities(session.ref.model).supports_resume) {
      throw new RealtimeUnsupportedFeatureError(
        'Realtime provider does not support reconnect/resume.',
      );
    }
    return this.connect({
      ...session.request,
      provider_state: session.ref.provider_state,
      metadata: { ...session.request.metadata, reconnect_from: session.ref.id },
    });
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readTransport(value: unknown): RealtimeConnectRequest['transport'] {
  return value === 'websocket' || value === 'webtransport' || value === 'webrtc'
    ? value
    : undefined;
}

function readToolMode(value: unknown): RealtimeConnectRequest['tool_mode'] {
  return value === 'manual' || value === 'provider_managed' ? value : undefined;
}

function readRealtimeConfig(value: unknown): RealtimeSessionConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const record = value as Readonly<Record<string, unknown>>;
  const audio =
    typeof record.audio === 'object' && record.audio !== null && !Array.isArray(record.audio)
      ? (record.audio as Readonly<Record<string, unknown>>)
      : undefined;
  return {
    ...(record as RealtimeSessionConfig),
    voice: readString(record.voice) ?? readString(audio?.voice),
  };
}

export class ManagedRealtimeSession {
  private sendChain = Promise.resolve<unknown>(undefined);
  private closed = false;
  private lastEventId?: string;

  constructor(
    readonly provider: RealtimeProvider,
    readonly ref: RealtimeSessionRef,
    readonly request: RealtimeConnectRequest,
  ) {}

  async *events(): AsyncIterable<AgentEvent> {
    this.assertOpen();
    for await (const event of this.provider.streamEvents(this.ref, {
      after_event_id: this.lastEventId,
    })) {
      this.lastEventId = event.id;
      yield { ...event, session_id: event.session_id ?? this.ref.id };
    }
  }

  send(command: RealtimeClientCommand): Promise<InvocationRef> {
    this.assertOpen();
    const operation = this.sendChain.then(() => this.provider.send(this.ref, command));
    this.sendChain = operation;
    return operation;
  }

  sendText(text: string): Promise<InvocationRef> {
    return this.send({ type: 'input_text.submit', data: { text } });
  }

  appendAudio(audio: Uint8Array): Promise<InvocationRef> {
    return this.send({
      type: 'input_audio.append',
      data: { audio_base64: Buffer.from(audio).toString('base64') },
    });
  }

  commitAudio(): Promise<InvocationRef> {
    return this.send({ type: 'input_audio.commit' });
  }

  addImage(image: Uint8Array, mediaType: string): Promise<InvocationRef> {
    return this.send({
      type: 'input_image.add',
      data: { data_base64: Buffer.from(image).toString('base64'), media_type: mediaType },
    });
  }

  createResponse(): Promise<InvocationRef> {
    return this.send({ type: 'response.create' });
  }

  interrupt(): Promise<InvocationRef> {
    return this.send({ type: 'response.cancel', data: { truncate_output: true } });
  }

  async update(config: RealtimeSessionConfig): Promise<void> {
    this.assertOpen();
    await this.sendChain;
    await this.provider.updateSession(this.ref, config);
  }

  async collect(): Promise<readonly AgentEvent[]> {
    const events: AgentEvent[] = [];
    for await (const event of this.events()) events.push(event);
    return events;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.sendChain;
    this.closed = true;
    await this.provider.close(this.ref);
  }

  connectingEvent(): AgentEvent {
    return createAgentEvent({
      type: AgentEventTypes.REALTIME_SESSION_CONNECTING,
      session_id: this.ref.id,
      provider: this.ref.provider,
      model: this.ref.model,
    });
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new RealtimeSessionError(`Realtime session '${this.ref.id}' is closed.`, {
        code: 'realtime_session_closed',
      });
    }
  }
}
