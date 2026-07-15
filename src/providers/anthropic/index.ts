import {
  assertTurnRequestCapabilities,
  capability,
  type CapabilityProfile,
} from '../../core/capabilities.js';
import type { AgentContentPart, AgentMessage } from '../../core/content.js';
import {
  ConfigurationError,
  ProviderExecutionError,
  UnsupportedFeatureError,
} from '../../core/errors.js';
import { AgentEventTypes, createAgentEvent, type AgentEvent } from '../../core/events.js';
import { createRunItem, type RunItem } from '../../core/items.js';
import type { MediaRef } from '../../core/media.js';
import { createProviderState, type ProviderState } from '../../core/state.js';
import { modelUsage, usageFromAnthropic, type ModelUsage } from '../../core/usage.js';
import {
  complete as completeTurn,
  normalizeTurnRequest,
  type AgentModelProvider,
  type LLMCompletionInput,
  type LLMCompletionResult,
  type ProviderModel,
  type TurnRequest,
  type TurnResult,
} from '../base.js';
import {
  decodeSSE,
  fetchWithRetry,
  parseSSEJson,
  readJson,
  stripTrailingSlash,
  throwResponseError,
  timeoutSignal,
} from '../http.js';

export interface AnthropicProviderConfig {
  readonly apiKey: string;
  readonly model: string;
  readonly apiBase?: string;
  readonly anthropicVersion?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly capabilities?: (model?: string) => CapabilityProfile;
  readonly models?: readonly ProviderModel[];
}

export interface AnthropicMessagesRequest extends Readonly<Record<string, unknown>> {
  readonly model: string;
  readonly system?: string | readonly unknown[];
  readonly messages: readonly unknown[];
  readonly max_tokens: number;
  readonly stream: true;
}

export class AnthropicMessagesProvider implements AgentModelProvider {
  readonly id = 'anthropic';
  readonly defaultModel: string;

  private readonly apiKey: string;
  private readonly apiBase: string;
  private readonly anthropicVersion: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs?: number;
  private readonly maxRetries: number;
  private readonly capabilityFactory: (model?: string) => CapabilityProfile;
  private readonly configuredModels: readonly ProviderModel[];

  constructor(config: AnthropicProviderConfig) {
    this.apiKey = config.apiKey;
    this.defaultModel = config.model;
    this.apiBase = stripTrailingSlash(config.apiBase ?? 'https://api.anthropic.com');
    this.anthropicVersion = config.anthropicVersion ?? '2023-06-01';
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs;
    this.maxRetries = config.maxRetries ?? 2;
    this.capabilityFactory = config.capabilities ?? anthropicMessagesCapabilityProfile;
    this.configuredModels = config.models ?? [];
  }

  capabilities(model?: string): CapabilityProfile {
    return this.capabilityFactory(model ?? this.defaultModel);
  }

  models(): readonly ProviderModel[] {
    return this.configuredModels;
  }

  complete(input: LLMCompletionInput): Promise<LLMCompletionResult> {
    return completeTurn(this, input);
  }

  buildMessagesRequest(input: TurnRequest): {
    readonly url: string;
    readonly body: AnthropicMessagesRequest;
    readonly headers: Readonly<Record<string, string>>;
  } {
    const request = normalizeTurnRequest(input);
    const mapped = applyAnthropicCache(
      mapAnthropicMessages(request.input, request.instructions),
      request.cache,
    );
    const body: Record<string, unknown> = {
      model: request.model,
      system: mapped.system,
      messages: [...(request.provider_state?.native_history ?? []), ...mapped.messages],
      max_tokens: request.max_tokens ?? request.max_output_tokens ?? 512,
      temperature: request.temperature,
      top_p: request.top_p,
      tools: mapAnthropicTools(request),
      tool_choice: mapToolChoice(request.tool_choice),
      output_config: mapAnthropicOutput(request),
      thinking:
        request.reasoning_effort === undefined
          ? undefined
          : { type: 'adaptive', effort: request.reasoning_effort },
      context_management: mapAnthropicCompaction(request.compaction),
      stream: true,
    };
    mergeExtra(body, request.extra);
    removeUndefined(body);
    return {
      url: `${this.apiBase}/v1/messages`,
      body: body as AnthropicMessagesRequest,
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': this.anthropicVersion,
      },
    };
  }

  async turn(request: TurnRequest): Promise<TurnResult> {
    const events: AgentEvent[] = [];
    let text = '';
    let usage: ModelUsage | undefined;
    let items: readonly RunItem[] | undefined;
    let state: ProviderState | undefined;
    let raw: unknown;
    for await (const event of this.streamTurn(request)) {
      events.push(event);
      if (event.type === AgentEventTypes.MODEL_TEXT_DELTA && typeof event.data.delta === 'string') {
        text += event.data.delta;
      }
      if (event.type === AgentEventTypes.MODEL_COMPLETED) {
        if (typeof event.data.output_text === 'string') text = event.data.output_text;
        usage = readUsage(event.data.usage) ?? usage;
        items = Array.isArray(event.data.items) ? (event.data.items as readonly RunItem[]) : items;
        state = readState(event.data.provider_state) ?? state;
        raw = event.raw;
      }
    }
    return {
      output_text: text,
      usage,
      tokens_in: usage?.input_tokens,
      tokens_out: usage?.output_tokens,
      items,
      provider_state: state,
      events,
      model: request.model,
      provider: this.id,
      raw_response: raw,
    };
  }

  async *streamTurn(input: TurnRequest): AsyncIterable<AgentEvent> {
    const request = normalizeTurnRequest(input);
    assertTurnRequestCapabilities(this.id, request, this.capabilities(request.model));
    const built = this.buildMessagesRequest(request);
    const timeout = timeoutSignal(this.timeoutMs, request.signal);
    try {
      const response = await fetchWithRetry(
        this.fetchImpl,
        built.url,
        {
          method: 'POST',
          headers: built.headers,
          body: JSON.stringify(built.body),
          signal: timeout.signal,
        },
        { max_retries: this.maxRetries },
      );
      if (!response.ok) await throwResponseError(this.id, response);
      const mapper = new AnthropicEventMapper(request);
      if (response.headers.get('content-type')?.includes('text/event-stream')) {
        for await (const message of decodeSSE(response, timeout.signal)) {
          const payload = parseSSEJson(message);
          if (payload !== undefined) yield* mapper.map(payload);
        }
      } else {
        const { json } = await readJson(response);
        yield* mapper.completeMessage(json);
      }
    } finally {
      timeout.cancel();
    }
  }
}

export class AnthropicProvider extends AnthropicMessagesProvider {}

export function createAnthropicProvider(config: AnthropicProviderConfig): AnthropicProvider {
  return new AnthropicProvider(config);
}

class AnthropicEventMapper {
  private text = '';
  private inputUsage: ModelUsage = modelUsage();
  private outputUsage: ModelUsage = modelUsage();
  private readonly blocks = new Map<number, Readonly<Record<string, unknown>>>();
  private readonly argumentDeltas = new Map<number, string>();
  private readonly items = new Map<number, RunItem>();

  constructor(private readonly request: TurnRequest) {}

  *map(payload: unknown): Iterable<AgentEvent> {
    if (!isRecord(payload)) return;
    const type = typeof payload.type === 'string' ? payload.type : 'anthropic.unknown';
    if (type === 'message_start') {
      const message = isRecord(payload.message) ? payload.message : {};
      this.inputUsage = usageFromAnthropic(message.usage);
      yield this.event(AgentEventTypes.MODEL_REQUEST_STARTED, payload, {
        model: message.model ?? this.request.model,
        message_id: message.id,
      });
      return;
    }
    if (type === 'content_block_start') {
      const index = numberOr(payload.index, 0);
      const block = isRecord(payload.content_block) ? payload.content_block : {};
      this.blocks.set(index, block);
      const item = mapAnthropicBlock(block, 'anthropic');
      if (item !== undefined) {
        this.items.set(index, item);
        yield this.event(AgentEventTypes.MODEL_ITEM_CREATED, payload, { item }, item.id);
      }
      return;
    }
    if (type === 'content_block_delta') {
      const index = numberOr(payload.index, 0);
      const delta = isRecord(payload.delta) ? payload.delta : {};
      if (delta.type === 'text_delta' && typeof delta.text === 'string') {
        this.text += delta.text;
        yield this.event(AgentEventTypes.MODEL_TEXT_DELTA, payload, { delta: delta.text });
      } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
        yield this.event(AgentEventTypes.MODEL_REASONING_DELTA, payload, {
          delta: delta.thinking,
        });
      } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        this.argumentDeltas.set(
          index,
          `${this.argumentDeltas.get(index) ?? ''}${delta.partial_json}`,
        );
      } else {
        yield this.event(type, payload, { index, delta });
      }
      return;
    }
    if (type === 'content_block_stop') {
      const index = numberOr(payload.index, 0);
      const original = this.items.get(index);
      if (original !== undefined) {
        const argumentsText = this.argumentDeltas.get(index);
        const item =
          argumentsText === undefined
            ? { ...original, status: 'completed' as const }
            : {
                ...original,
                status: 'completed' as const,
                data: { ...original.data, arguments: argumentsText },
              };
        this.items.set(index, item);
        yield this.event(AgentEventTypes.MODEL_ITEM_COMPLETED, payload, { item }, item.id);
      }
      return;
    }
    if (type === 'message_delta') {
      this.outputUsage = usageFromAnthropic(payload.usage);
      yield this.event(type, payload, { usage: this.outputUsage });
      return;
    }
    if (type === 'message_stop') {
      yield this.completed(payload);
      return;
    }
    if (type === 'error') throw new ProviderExecutionError('anthropic', 502, payload);
    yield this.event(type, payload, { provider_event_type: type });
  }

  *completeMessage(value: unknown): Iterable<AgentEvent> {
    if (!isRecord(value)) throw new ProviderExecutionError('anthropic', 502, value);
    yield this.event(AgentEventTypes.MODEL_REQUEST_STARTED, value, { model: value.model });
    this.inputUsage = usageFromAnthropic(value.usage);
    const content: readonly unknown[] = Array.isArray(value.content) ? value.content : [];
    content.forEach((block, index) => {
      if (isRecord(block)) this.blocks.set(index, block);
      const item = mapAnthropicBlock(block, 'anthropic');
      if (item !== undefined) this.items.set(index, { ...item, status: 'completed' });
    });
    this.text = extractAnthropicText(value);
    yield this.completed(value);
  }

  private completed(raw: unknown): AgentEvent {
    const usage = modelUsage({
      input_tokens: this.inputUsage.input_tokens,
      output_tokens: Math.max(this.inputUsage.output_tokens, this.outputUsage.output_tokens),
      cache_read_input_tokens: this.inputUsage.cache_read_input_tokens,
      cache_creation_input_tokens: this.inputUsage.cache_creation_input_tokens,
      provider_details: {
        input: this.inputUsage.provider_details,
        output: this.outputUsage.provider_details,
      },
    });
    const nativeHistory = [
      {
        role: 'assistant',
        content: [...this.blocks.values()],
      },
    ];
    const state = createProviderState({
      provider: 'anthropic',
      model: this.request.model,
      native_history: nativeHistory,
      reasoning_state: {
        signatures: [...this.blocks.values()]
          .map((block) => block.signature)
          .filter((value) => typeof value === 'string'),
      },
      tool_state: {
        tool_use_ids: [...this.items.values()]
          .filter((item) => item.type === 'function_call')
          .map((item) => item.id),
      },
    });
    return this.event(AgentEventTypes.MODEL_COMPLETED, raw, {
      output_text: this.text,
      usage,
      items: [...this.items.values()],
      provider_state: state,
    });
  }

  private event(
    type: string,
    raw: unknown,
    data: Readonly<Record<string, unknown>>,
    itemId?: string,
  ): AgentEvent {
    return createAgentEvent({
      type,
      provider: 'anthropic',
      model: this.request.model,
      trace_id: this.request.trace_id,
      item_id: itemId,
      data,
      raw,
    });
  }
}

export function anthropicMessagesCapabilityProfile(model?: string): CapabilityProfile {
  const modern = model?.includes('4-6') === true || model?.includes('4-7') === true;
  return {
    provider: 'anthropic',
    model,
    summary: {
      supports_streaming_events: true,
      supports_function_tools: true,
      supports_parallel_tool_calls: true,
      supports_hosted_tools: true,
      supports_mcp: true,
      supports_workspaces: false,
      supports_provider_state: true,
      supports_structured_output: modern,
    },
    tools: {
      function_tools: capability('supported'),
      parallel_tool_calls: capability('supported'),
    },
    hosted_tools: {
      hosted_tools: capability('unsupported'),
      web_search: capability('supported'),
      remote_mcp: capability('supported'),
      raw: capability('passthrough'),
    },
    output: {
      text: capability('supported'),
      structured_output: modern
        ? capability('supported')
        : capability('unsupported', { reason: 'Native output format requires Claude 4.6+.' }),
      provider_native: modern
        ? capability('supported')
        : capability('unsupported', { reason: 'Native output format requires Claude 4.6+.' }),
      finalizer_tool: capability('supported'),
      posthoc_parse: capability('supported'),
      posthoc_parse_with_retry: capability('supported'),
    },
    controls: {
      instructions: capability('supported'),
      max_output_tokens: capability('supported'),
      temperature: capability('supported'),
      top_p: capability('supported'),
      tool_choice: capability('supported'),
      parallel_tool_calls: capability('unsupported'),
      reasoning_effort: capability('supported', {
        supported_values: ['low', 'medium', 'high'],
      }),
      compaction: modern
        ? capability('supported')
        : capability('unsupported', { reason: 'Context editing requires Claude 4.6+.' }),
      cache: capability('supported'),
      extra: capability('passthrough'),
    },
    state: {
      provider_stateful: capability('supported'),
      stateless_replay: capability('supported'),
    },
    integrations: {
      mcp: capability('unsupported', {
        reason: 'Use the typed remote_mcp hosted tool for provider-native MCP.',
      }),
      workspace: capability('unsupported'),
    },
    source: 'blackbox-ts:anthropic-messages',
  };
}

export function extractAnthropicText(json: unknown): string {
  if (!isRecord(json) || !Array.isArray(json.content)) return '';
  const content: readonly unknown[] = json.content;
  return content
    .map((block) =>
      isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? block.text : '',
    )
    .filter(Boolean)
    .join('');
}

function mapAnthropicMessages(
  input: TurnRequest['input'],
  instructions?: string,
): { readonly system?: string; readonly messages: readonly unknown[] } {
  const system: string[] = instructions === undefined ? [] : [instructions];
  if (typeof input === 'string') {
    return {
      system: system.join('\n\n') || undefined,
      messages: [{ role: 'user', content: input }],
    };
  }
  const messages: unknown[] = [];
  for (const message of input) {
    if (message.role === 'system') {
      system.push(messageToText(message));
      continue;
    }
    if (message.role === 'tool') {
      messages.push({ role: 'user', content: mapToolResults(message) });
      continue;
    }
    messages.push({
      role: message.role,
      content:
        typeof message.content === 'string'
          ? message.content
          : message.content.map(mapAnthropicPart),
    });
  }
  return { system: system.join('\n\n') || undefined, messages };
}

function applyAnthropicCache(
  mapped: { readonly system?: string; readonly messages: readonly unknown[] },
  cache: unknown,
): { readonly system?: string | readonly unknown[]; readonly messages: readonly unknown[] } {
  if (cache === undefined) return mapped;
  const cacheControl =
    isRecord(cache) && isRecord(cache.control) ? cache.control : { type: 'ephemeral' };
  if (mapped.system !== undefined) {
    return {
      ...mapped,
      system: [{ type: 'text', text: mapped.system, cache_control: cacheControl }],
    };
  }
  const messages = [...mapped.messages];
  const last = messages.at(-1);
  if (isRecord(last)) {
    const content = last.content;
    let blocks: unknown[] = [];
    if (typeof content === 'string') blocks = [{ type: 'text', text: content }];
    else if (Array.isArray(content)) {
      const sequence: readonly unknown[] = content;
      blocks = [...sequence];
    }
    const lastBlock = blocks.at(-1);
    if (isRecord(lastBlock))
      blocks[blocks.length - 1] = { ...lastBlock, cache_control: cacheControl };
    messages[messages.length - 1] = { ...last, content: blocks };
  }
  return { ...mapped, messages };
}

function messageToText(message: AgentMessage): string {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .map((part) => {
      if (part.type === 'text') return part.text;
      if (part.type === 'json') return JSON.stringify(part.value);
      throw new UnsupportedFeatureError(
        'anthropic.system_content',
        `Anthropic system messages cannot contain '${part.type}'.`,
      );
    })
    .join('\n');
}

function mapToolResults(message: AgentMessage): readonly unknown[] {
  if (typeof message.content === 'string') {
    if (message.tool_call_id === undefined) {
      throw new UnsupportedFeatureError(
        'anthropic.tool_call_id',
        'Tool messages require tool_call_id.',
      );
    }
    return [{ type: 'tool_result', tool_use_id: message.tool_call_id, content: message.content }];
  }
  return message.content.map((part) => {
    if (part.type !== 'tool_result') {
      throw new UnsupportedFeatureError(
        'anthropic.tool_message_part',
        `Anthropic tool messages require tool_result parts, received '${part.type}'.`,
      );
    }
    return {
      type: 'tool_result',
      tool_use_id: part.tool_call_id,
      content: typeof part.output === 'string' ? part.output : JSON.stringify(part.output),
      is_error: part.is_error,
    };
  });
}

function mapAnthropicPart(part: AgentContentPart): unknown {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text };
    case 'json':
      return { type: 'text', text: JSON.stringify(part.value) };
    case 'image':
      return { type: 'image', source: mediaSource(part.media) };
    case 'file':
      return { type: 'document', source: mediaSource(part.media) };
    case 'file_ref':
      return { type: 'document', source: { type: 'file', file_id: part.file_id } };
    case 'provider_native':
    case 'raw':
      return part.value;
    case 'audio':
    case 'video_frame':
      throw new UnsupportedFeatureError(
        `anthropic.content.${part.type}`,
        `Anthropic Messages mapping does not support '${part.type}'.`,
      );
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: part.tool_call_id,
        content: typeof part.output === 'string' ? part.output : JSON.stringify(part.output),
        is_error: part.is_error,
      };
  }
}

function mediaSource(media: MediaRef): Readonly<Record<string, unknown>> {
  if (media.provider_file_id !== undefined)
    return { type: 'file', file_id: media.provider_file_id };
  if (media.url !== undefined) return { type: 'url', url: media.url };
  if (media.data_base64 !== undefined) {
    return { type: 'base64', media_type: media.mime_type, data: media.data_base64 };
  }
  throw new UnsupportedFeatureError('anthropic.media_source', 'Media has no mappable source.');
}

function mapAnthropicTools(request: TurnRequest): readonly unknown[] | undefined {
  const tools: unknown[] = (request.tools ?? []).map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema ?? { type: 'object', properties: {} },
  }));
  for (const hosted of request.hosted_tools ?? []) {
    if (hosted.type === 'raw') tools.push({ ...(hosted.config ?? {}) });
    else if (hosted.type === 'web_search') {
      tools.push({
        type: 'web_search_20250305',
        name: hosted.name ?? 'web_search',
        ...(hosted.config ?? {}),
      });
    } else if (hosted.type === 'remote_mcp') {
      tools.push({ type: 'mcp_toolset', name: hosted.name, ...(hosted.config ?? {}) });
    }
  }
  return tools.length === 0 ? undefined : tools;
}

function mapToolChoice(value: TurnRequest['tool_choice']): unknown {
  if (value === undefined) return undefined;
  if (value === 'auto' || value === 'none' || value === 'required') {
    return { type: value === 'required' ? 'any' : value };
  }
  return { type: 'tool', name: value };
}

function mapAnthropicOutput(request: TurnRequest): unknown {
  if (request.output?.strategy !== 'provider_native' || request.output.schema === undefined) {
    return request.response_format?.type === 'json_schema'
      ? { format: { type: 'json_schema', schema: request.response_format.schema } }
      : undefined;
  }
  return { format: { type: 'json_schema', schema: request.output.schema } };
}

function mapAnthropicCompaction(value: unknown): unknown {
  return isRecord(value) && value.strategy === 'auto'
    ? { edits: [{ type: 'clear_tool_uses_20250919' }] }
    : undefined;
}

function mapAnthropicBlock(value: unknown, provider: string): RunItem | undefined {
  if (!isRecord(value)) return undefined;
  const type = value.type;
  if (type === 'text') {
    return createRunItem({
      id: readString(value, 'id'),
      type: 'message',
      provider,
      data: value,
      raw: value,
    });
  }
  if (type === 'thinking' || type === 'redacted_thinking') {
    return createRunItem({
      id: readString(value, 'id'),
      type: 'reasoning',
      provider,
      data: value,
      raw: value,
    });
  }
  if (type === 'tool_use' || type === 'server_tool_use') {
    return createRunItem({
      id: readString(value, 'id'),
      type: type === 'tool_use' ? 'function_call' : 'hosted_tool_call',
      provider,
      data: {
        name: value.name,
        call_id: value.id,
        arguments: value.input ?? {},
      },
      raw: value,
    });
  }
  return undefined;
}

function mergeExtra(
  body: Record<string, unknown>,
  extra: Readonly<Record<string, unknown>> | undefined,
): void {
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (key in body && body[key] !== undefined) {
      throw new ConfigurationError(
        `Provider extra field '${key}' collides with a normalized request field.`,
        {
          code: 'provider_extra_collision',
        },
      );
    }
    body[key] = value;
  }
}

function removeUndefined(value: Record<string, unknown>): void {
  for (const key of Object.keys(value)) if (value[key] === undefined) delete value[key];
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' ? value : fallback;
}

function readString(value: unknown, key: string): string | undefined {
  return isRecord(value) && typeof value[key] === 'string' ? value[key] : undefined;
}

function readUsage(value: unknown): ModelUsage | undefined {
  return isRecord(value) && typeof value.input_tokens === 'number'
    ? (value as unknown as ModelUsage)
    : undefined;
}

function readState(value: unknown): ProviderState | undefined {
  return isRecord(value) && typeof value.provider === 'string'
    ? (value as unknown as ProviderState)
    : undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
