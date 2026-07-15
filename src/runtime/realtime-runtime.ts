import { RealtimeSessionError, RealtimeUnsupportedFeatureError } from '../core/errors.js';
import { AgentEventTypes, createAgentEvent, type AgentEvent } from '../core/events.js';
import { ApprovalManager, type ApprovalDecision } from '../core/approvals.js';
import { allow, AllowAllPolicy, type Policy } from '../core/policy.js';
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
import { ToolRegistry } from '../tools/registry.js';
import { ToolRuntime } from '../tools/runtime.js';
import type { ToolDefinition } from '../tools/types.js';
import type { EventStore } from '../persistence/stores.js';
import type { EventSink } from '../observability/sinks.js';

export interface RealtimeRuntimeConnectRequest extends Omit<RealtimeConnectRequest, 'tools'> {
  readonly tools?: readonly (string | ToolDefinition)[];
  readonly tool_execution_context?: Readonly<Record<string, unknown>>;
  readonly tool_timeout_ms?: number;
  readonly tool_max_concurrent?: number;
  readonly approval_manager?: ApprovalManager;
  readonly policy?: Policy;
}

export class RealtimeRuntime {
  private readonly sessions = new Map<string, ManagedRealtimeSession>();
  readonly approvals = new ApprovalManager();

  constructor(
    readonly registry: ProviderRegistry,
    readonly tools = new ToolRegistry(),
    readonly policy: Policy = new AllowAllPolicy(),
    private readonly eventStore?: EventStore,
    private readonly eventSink?: EventSink,
  ) {}

  async connect(request: RealtimeRuntimeConnectRequest): Promise<ManagedRealtimeSession> {
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
    validateRealtimeConfig(capabilities, sessionConfig);
    const toolRegistry = this.tools.session();
    const toolDefinitions = (request.tools ?? []).map((tool) => {
      if (typeof tool === 'string') return toolRegistry.get(tool);
      if (!toolRegistry.has(tool.name)) toolRegistry.register(tool);
      return tool;
    });
    const toolMode = request.tool_mode ?? readToolMode(configured.tool_mode) ?? 'manual';
    if (toolMode === 'disabled' && toolDefinitions.length > 0) {
      throw new RealtimeUnsupportedFeatureError(
        "Realtime tool_mode='disabled' cannot be used with local tools.",
      );
    }
    if (toolDefinitions.length > 0 && !capabilities.supports_tools) {
      throw new RealtimeUnsupportedFeatureError('Realtime tools are unsupported.');
    }
    const providerRequest: RealtimeConnectRequest = {
      ...request,
      model: parsed.model,
      runtime_config: undefined,
      config: sessionConfig,
      transport,
      tools: toolDefinitions,
      tool_mode: toolMode,
    };
    deleteRuntimeFields(providerRequest);
    const ref = await provider.connect(providerRequest);
    const session = new ManagedRealtimeSession(
      provider,
      ref,
      {
        ...providerRequest,
        model: modelRef,
      },
      {
        tool_mode: toolMode,
        tool_runtime:
          toolMode === 'auto' && toolDefinitions.length > 0
            ? new ToolRuntime(toolRegistry, {
                context: request.tool_execution_context,
                timeout_ms: request.tool_timeout_ms,
                max_concurrency: request.tool_max_concurrent,
              })
            : undefined,
        policy: request.policy ?? this.policy,
        approvals: request.approval_manager ?? this.approvals,
        event_store: this.eventStore,
        event_sink: this.eventSink,
        validate_config: (config) => validateRealtimeConfig(capabilities, config),
        on_close: () => this.sessions.delete(ref.id),
      },
    );
    this.sessions.set(ref.id, session);
    return session;
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

  approve(approvalId: string, decision: ApprovalDecision): void {
    this.approvals.decide(approvalId, decision);
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
  return value === 'manual' ||
    value === 'auto' ||
    value === 'disabled' ||
    value === 'provider_managed'
    ? value
    : undefined;
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
  private sequence = 0;
  private readonly runId: string;
  private readonly toolMode: NonNullable<RealtimeConnectRequest['tool_mode']>;
  private readonly toolRuntime?: ToolRuntime;
  private readonly policy: Policy;
  private readonly approvals: ApprovalManager;

  constructor(
    readonly provider: RealtimeProvider,
    readonly ref: RealtimeSessionRef,
    readonly request: RealtimeConnectRequest,
    private readonly options: ManagedRealtimeSessionOptions = {},
  ) {
    this.runId = request.run_id ?? crypto.randomUUID();
    this.toolMode = options.tool_mode ?? request.tool_mode ?? 'manual';
    this.toolRuntime = options.tool_runtime;
    this.policy = options.policy ?? new AllowAllPolicy();
    this.approvals = options.approvals ?? new ApprovalManager();
  }

  async *events(): AsyncIterable<AgentEvent> {
    this.assertOpen();
    for await (const event of this.provider.streamEvents(this.ref, {
      after_event_id: this.lastEventId,
    })) {
      this.lastEventId = event.id;
      const stamped = await this.stamp(event);
      yield stamped;
      if (this.toolMode === 'auto' && stamped.type === AgentEventTypes.TOOL_CALL_REQUESTED) {
        yield* this.executeToolCall(stamped);
      }
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

  sendToolResult(
    callId: string,
    output: string,
    options: { readonly is_error?: boolean; readonly trigger_response?: boolean } = {},
  ): Promise<InvocationRef> {
    return this.send({
      type: 'tool_result',
      data: {
        call_id: callId,
        output,
        is_error: options.is_error ?? false,
        trigger_response: options.trigger_response ?? true,
      },
    });
  }

  async update(config: RealtimeSessionConfig): Promise<void> {
    this.assertOpen();
    this.options.validate_config?.(config);
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
    this.options.on_close?.();
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

  private async *executeToolCall(event: AgentEvent): AsyncIterable<AgentEvent> {
    const name = readEventString(event, 'name');
    const callId = readEventString(event, 'call_id') ?? event.item_id ?? crypto.randomUUID();
    if (name === undefined || this.toolRuntime === undefined) {
      yield await this.stamp(
        createAgentEvent({
          type: AgentEventTypes.TOOL_CALL_FAILED,
          provider: this.ref.provider,
          session_id: this.ref.id,
          item_id: callId,
          data: {
            call_id: callId,
            name,
            error: name === undefined ? 'missing_tool_name' : 'no_tool_runtime',
          },
        }),
      );
      return;
    }
    const originalArguments = readEventRecord(event, 'arguments');
    const policy =
      (await this.policy.check({
        checkpoint: 'before_tool_call',
        action: name,
        arguments: originalArguments,
        metadata: { realtime: true, session_id: this.ref.id },
      })) ?? allow();
    if (policy.verdict === 'deny') {
      yield* this.denyTool(callId, name, 'denied_by_policy', policy.reason);
      return;
    }
    let arguments_ = originalArguments;
    if (policy.verdict === 'require_approval') {
      const ticket = this.approvals.request(name, {
        reason: policy.reason,
        data: { checkpoint: 'before_tool_call', arguments: arguments_, realtime: true },
      });
      yield await this.stamp(
        createAgentEvent({
          type: AgentEventTypes.APPROVAL_REQUESTED,
          provider: this.ref.provider,
          session_id: this.ref.id,
          item_id: callId,
          data: { approval_id: ticket.request.id, request: ticket.request },
        }),
      );
      const decision = await ticket.decision;
      yield await this.stamp(
        createAgentEvent({
          type: decision.approved
            ? AgentEventTypes.APPROVAL_APPROVED
            : AgentEventTypes.APPROVAL_DENIED,
          provider: this.ref.provider,
          session_id: this.ref.id,
          item_id: callId,
          data: { approval_id: ticket.request.id, decision },
        }),
      );
      if (!decision.approved) {
        yield* this.denyTool(callId, name, 'denied_by_approval', decision.reason);
        return;
      }
      arguments_ = decision.modified_arguments ?? arguments_;
    }
    yield await this.stamp(
      createAgentEvent({
        type: AgentEventTypes.TOOL_CALL_STARTED,
        provider: this.ref.provider,
        session_id: this.ref.id,
        item_id: callId,
        data: { call_id: callId, name, arguments: arguments_ },
      }),
    );
    try {
      const result = await this.toolRuntime.call(name, arguments_);
      yield await this.stamp(
        createAgentEvent({
          type: result.is_error
            ? AgentEventTypes.TOOL_CALL_FAILED
            : AgentEventTypes.TOOL_CALL_COMPLETED,
          provider: this.ref.provider,
          session_id: this.ref.id,
          item_id: callId,
          data: {
            call_id: callId,
            name,
            content: result.content,
            payload: result.payload,
            metadata: result.metadata,
          },
        }),
      );
      await this.sendToolResult(callId, result.content, { is_error: result.is_error });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Tool execution failed.';
      yield await this.stamp(
        createAgentEvent({
          type: AgentEventTypes.TOOL_CALL_FAILED,
          provider: this.ref.provider,
          session_id: this.ref.id,
          item_id: callId,
          data: { call_id: callId, name, error: message },
        }),
      );
      await this.sendToolResult(callId, JSON.stringify({ error: message }), { is_error: true });
    }
  }

  private async *denyTool(
    callId: string,
    name: string,
    error: string,
    reason?: string,
  ): AsyncIterable<AgentEvent> {
    yield await this.stamp(
      createAgentEvent({
        type: AgentEventTypes.TOOL_CALL_FAILED,
        provider: this.ref.provider,
        session_id: this.ref.id,
        item_id: callId,
        data: { call_id: callId, name, error, reason },
      }),
    );
    await this.sendToolResult(callId, JSON.stringify({ error, reason }), { is_error: true });
  }

  private async stamp(event: AgentEvent): Promise<AgentEvent> {
    const stamped = {
      ...event,
      run_id: event.run_id ?? this.runId,
      session_id: event.session_id ?? this.ref.id,
      sequence: event.sequence ?? this.sequence,
      provider: event.provider ?? this.ref.provider,
      model: event.model ?? this.ref.model,
    };
    this.sequence = Math.max(this.sequence + 1, stamped.sequence + 1);
    await this.options.event_store?.append(stamped);
    await this.options.event_sink?.emit(stamped);
    return stamped;
  }
}

interface ManagedRealtimeSessionOptions {
  readonly tool_mode?: NonNullable<RealtimeConnectRequest['tool_mode']>;
  readonly tool_runtime?: ToolRuntime;
  readonly policy?: Policy;
  readonly approvals?: ApprovalManager;
  readonly event_store?: EventStore;
  readonly event_sink?: EventSink;
  readonly validate_config?: (config: RealtimeSessionConfig) => void;
  readonly on_close?: () => void;
}

type MutableRealtimeConnectRequest = {
  -readonly [Key in keyof RealtimeRuntimeConnectRequest]?: RealtimeRuntimeConnectRequest[Key];
};

function deleteRuntimeFields(request: MutableRealtimeConnectRequest): void {
  delete request.tool_execution_context;
  delete request.tool_timeout_ms;
  delete request.tool_max_concurrent;
  delete request.approval_manager;
  delete request.policy;
}

function readEventString(event: AgentEvent, key: string): string | undefined {
  const value = event.data[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readEventRecord(event: AgentEvent, key: string): Readonly<Record<string, unknown>> {
  const value = event.data[key];
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function validateRealtimeConfig(
  capabilities: ReturnType<RealtimeProvider['capabilities']>,
  config: RealtimeSessionConfig,
): void {
  for (const modality of config.input_modalities ?? []) {
    if (!capabilities.input_modalities.includes(modality)) {
      throw new RealtimeUnsupportedFeatureError(
        `Realtime input modality '${modality}' is unsupported.`,
      );
    }
  }
  for (const modality of config.output_modalities ?? []) {
    if (!capabilities.output_modalities.includes(modality)) {
      throw new RealtimeUnsupportedFeatureError(
        `Realtime output modality '${modality}' is unsupported.`,
      );
    }
  }
}
