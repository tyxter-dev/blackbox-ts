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
import { createRunItem, type RunItem, type RunItemType } from '../../core/items.js';
import { createProviderState, type ProviderState } from '../../core/state.js';
import { usageFromOpenAI, type ModelUsage } from '../../core/usage.js';
import type { MediaRef } from '../../core/media.js';
import {
  complete as completeTurn,
  normalizeTurnRequest,
  type AgentModelProvider,
  type HostedToolSpec,
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
import type { ProviderToolDefinition } from '../../tools/types.js';

export interface OpenAIResponsesProviderConfig {
  readonly apiKey: string;
  readonly model: string;
  readonly apiBase?: string;
  readonly providerId?: string;
  readonly defaultHeaders?: Readonly<Record<string, string>>;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly capabilities?: (model?: string) => CapabilityProfile;
  readonly models?: readonly ProviderModel[];
}

export class OpenAIResponsesProvider implements AgentModelProvider {
  readonly id: string;
  readonly defaultModel: string;

  private readonly apiKey: string;
  private readonly apiBase: string;
  private readonly defaultHeaders: Readonly<Record<string, string>>;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs?: number;
  private readonly maxRetries: number;
  private readonly capabilityFactory: (model?: string) => CapabilityProfile;
  private readonly configuredModels: readonly ProviderModel[];

  constructor(config: OpenAIResponsesProviderConfig) {
    this.id = config.providerId ?? 'openai';
    this.defaultModel = config.model;
    this.apiKey = config.apiKey;
    this.apiBase = stripTrailingSlash(config.apiBase ?? 'https://api.openai.com/v1');
    this.defaultHeaders = config.defaultHeaders ?? {};
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs;
    this.maxRetries = config.maxRetries ?? 2;
    this.capabilityFactory =
      config.capabilities ?? ((model) => openAIResponsesCapabilityProfile(this.id, model));
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

  buildResponsesRequest(request: TurnRequest): {
    readonly url: string;
    readonly body: Readonly<Record<string, unknown>>;
    readonly headers: Readonly<Record<string, string>>;
  } {
    request = normalizeTurnRequest(request);
    const body: Record<string, unknown> = {
      model: request.model,
      input: mapOpenAIInput(request.input),
      instructions: request.instructions,
      tools: mapOpenAITools(request.tools ?? [], request.hosted_tools ?? []),
      text: mapOpenAITextFormat(request),
      max_output_tokens: request.max_output_tokens ?? request.max_tokens,
      temperature: request.temperature,
      top_p: request.top_p,
      tool_choice: request.tool_choice,
      parallel_tool_calls: request.parallel_tool_calls,
      reasoning:
        request.reasoning_effort === undefined ? undefined : { effort: request.reasoning_effort },
      include: request.include,
      background: request.background,
      store: request.store,
      previous_response_id: request.provider_state?.previous_response_id,
      truncation: mapCompaction(request.compaction),
      stream: true,
    };
    mapCache(body, request.cache);
    mergeExtra(body, request.extra);
    removeUndefined(body);
    return {
      url: `${this.apiBase}/responses`,
      body,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
        ...this.defaultHeaders,
      },
    };
  }

  async turn(request: TurnRequest): Promise<TurnResult> {
    const events: AgentEvent[] = [];
    let outputText = '';
    let usage: ModelUsage | undefined;
    let providerState: ProviderState | undefined;
    let items: readonly RunItem[] | undefined;
    let rawResponse: unknown;
    for await (const event of this.streamTurn(request)) {
      events.push(event);
      if (event.type === AgentEventTypes.MODEL_TEXT_DELTA && typeof event.data.delta === 'string') {
        outputText += event.data.delta;
      }
      if (event.type === AgentEventTypes.MODEL_COMPLETED) {
        if (typeof event.data.output_text === 'string') outputText = event.data.output_text;
        usage = readUsage(event.data.usage) ?? usage;
        providerState = readState(event.data.provider_state) ?? providerState;
        items = Array.isArray(event.data.items) ? (event.data.items as readonly RunItem[]) : items;
        rawResponse = event.raw;
      }
    }
    return {
      output_text: outputText,
      usage,
      provider_state: providerState,
      items,
      events,
      tokens_in: usage?.input_tokens,
      tokens_out: usage?.output_tokens,
      model: request.model,
      provider: this.id,
      raw_response: rawResponse,
    };
  }

  async *streamTurn(input: TurnRequest): AsyncIterable<AgentEvent> {
    const request = normalizeTurnRequest(input);
    assertTurnRequestCapabilities(this.id, request, this.capabilities(request.model));
    const built = this.buildResponsesRequest(request);
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

      const mapper = new OpenAIEventMapper(this.id, request);
      if (response.headers.get('content-type')?.includes('text/event-stream')) {
        for await (const message of decodeSSE(response, timeout.signal)) {
          const payload = parseSSEJson(message);
          if (payload === undefined) continue;
          yield* mapper.map(payload);
        }
      } else {
        const { json } = await readJson(response);
        yield* mapper.map({ type: 'response.completed', response: json });
      }
    } finally {
      timeout.cancel();
    }
  }
}

class OpenAIEventMapper {
  private text = '';
  private readonly items = new Map<string, RunItem>();

  constructor(
    private readonly provider: string,
    private readonly request: TurnRequest,
  ) {}

  *map(payload: unknown): Iterable<AgentEvent> {
    if (!isRecord(payload)) return;
    const type = typeof payload.type === 'string' ? payload.type : 'response.unknown';
    if (type === 'response.created') {
      yield this.event(AgentEventTypes.MODEL_REQUEST_STARTED, payload, {
        model: this.request.model,
        response_id: readString(payload.response, 'id'),
      });
      return;
    }
    if (type === 'response.output_text.delta') {
      const delta = typeof payload.delta === 'string' ? payload.delta : '';
      this.text += delta;
      yield this.event(AgentEventTypes.MODEL_TEXT_DELTA, payload, { delta });
      return;
    }
    if (
      type === 'response.reasoning_text.delta' ||
      type === 'response.reasoning_summary_text.delta'
    ) {
      yield this.event(AgentEventTypes.MODEL_REASONING_DELTA, payload, {
        delta: typeof payload.delta === 'string' ? payload.delta : '',
      });
      return;
    }
    if (type === 'response.output_item.added' || type === 'response.output_item.done') {
      const item = mapOpenAIItem(payload.item, this.provider);
      if (item !== undefined) {
        this.items.set(item.id, item);
        yield this.event(
          type.endsWith('.added')
            ? AgentEventTypes.MODEL_ITEM_CREATED
            : AgentEventTypes.MODEL_ITEM_COMPLETED,
          payload,
          { item },
          item.id,
        );
      }
      return;
    }
    if (type === 'response.completed') {
      const response = isRecord(payload.response) ? payload.response : payload;
      const output = Array.isArray(response.output) ? response.output : [];
      for (const nativeItem of output) {
        const item = mapOpenAIItem(nativeItem, this.provider);
        if (item !== undefined) this.items.set(item.id, item);
      }
      const responseText = extractResponseText(response) || this.text;
      const state = createProviderState({
        provider: this.provider,
        model: this.request.model,
        previous_response_id: readString(response, 'id'),
        native_history: output,
        tool_state: {
          output_item_ids: [...this.items.keys()],
          function_call_ids: [...this.items.values()]
            .filter((item) => item.type === 'function_call')
            .map((item) => item.data.call_id),
        },
      });
      yield this.event(AgentEventTypes.MODEL_COMPLETED, payload, {
        output_text: responseText,
        usage: usageFromOpenAI(response.usage),
        provider_state: state,
        items: [...this.items.values()],
        response_id: response.id,
      });
      return;
    }
    if (type === 'response.failed' || type === 'error') {
      throw new ProviderExecutionError(this.provider, 502, payload);
    }

    yield this.event(type, payload, { provider_event_type: type });
  }

  private event(
    type: string,
    raw: unknown,
    data: Readonly<Record<string, unknown>>,
    itemId?: string,
  ): AgentEvent {
    return createAgentEvent({
      type,
      provider: this.provider,
      model: this.request.model,
      trace_id: this.request.trace_id,
      item_id: itemId,
      provider_request_id: readString(raw, 'request_id'),
      data,
      raw,
    });
  }
}

export function openAIResponsesCapabilityProfile(
  provider = 'openai',
  model?: string,
): CapabilityProfile {
  return {
    provider,
    model,
    summary: {
      supports_streaming_events: true,
      supports_function_tools: true,
      supports_parallel_tool_calls: true,
      supports_hosted_tools: true,
      supports_mcp: true,
      supports_workspaces: false,
      supports_provider_state: true,
      supports_structured_output: true,
    },
    tools: {
      function_tools: capability('supported'),
      parallel_tool_calls: capability('supported'),
    },
    hosted_tools: {
      ...Object.fromEntries(
        [
          'hosted_tools',
          'web_search',
          'file_search',
          'code_interpreter',
          'remote_mcp',
          'mcp',
          'tool_search',
          'image_generation',
        ].map((name) => [name, capability('supported')]),
      ),
      raw: capability('passthrough'),
    },
    output: {
      text: capability('supported'),
      structured_output: capability('supported'),
      provider_native: capability('supported'),
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
      parallel_tool_calls: capability('supported'),
      reasoning_effort: capability('supported', {
        supported_values: ['minimal', 'low', 'medium', 'high'],
      }),
      verbosity: capability('supported', { supported_values: ['low', 'medium', 'high'] }),
      tool_search: capability('supported'),
      compaction: capability('supported'),
      cache: capability('supported'),
      background: capability('supported'),
      store: capability('supported'),
      include: capability('supported'),
      modalities: capability('unsupported'),
      extra: capability('passthrough'),
    },
    state: {
      provider_stateful: capability('supported'),
      stateless_replay: capability('supported'),
    },
    integrations: {
      mcp: capability('supported'),
      workspace: capability('unsupported'),
    },
    source: 'blackbox-ts:openai-responses',
  };
}

function mapOpenAITools(
  tools: readonly ProviderToolDefinition[],
  hosted: readonly HostedToolSpec[],
): readonly unknown[] | undefined {
  const mapped = [
    ...tools.map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema ?? { type: 'object', properties: {} },
    })),
    ...hosted.map(mapHostedTool),
  ];
  return mapped.length === 0 ? undefined : mapped;
}

function mapHostedTool(tool: HostedToolSpec): Readonly<Record<string, unknown>> {
  if (tool.type === 'raw') return { ...(tool.config ?? {}) };
  const type = tool.type === 'remote_mcp' ? 'mcp' : tool.type;
  return { type, ...(tool.name === undefined ? {} : { name: tool.name }), ...(tool.config ?? {}) };
}

function mapOpenAITextFormat(request: TurnRequest): unknown {
  if (request.output?.strategy === 'provider_native' && request.output.schema !== undefined) {
    return {
      format: {
        type: 'json_schema',
        name: request.output.name ?? 'structured_output',
        schema: request.output.schema,
        strict: request.output.strict,
      },
    };
  }
  if (request.response_format?.type === 'json_schema') {
    return {
      format: {
        type: 'json_schema',
        name: request.response_format.name,
        schema: request.response_format.schema,
        strict: request.response_format.strict,
      },
    };
  }
  return undefined;
}

function mapOpenAIInput(input: TurnRequest['input']): unknown {
  if (typeof input === 'string') return input;
  return input.flatMap((message) => mapMessage(message));
}

function mapMessage(message: AgentMessage): readonly unknown[] {
  const parts =
    typeof message.content === 'string'
      ? [{ type: 'text', text: message.content } as const]
      : message.content;
  if (message.role === 'tool') {
    return parts.map((part) => {
      if (part.type !== 'tool_result') {
        throw new UnsupportedFeatureError(
          'openai.tool_message_part',
          `OpenAI tool messages require tool_result parts, received '${part.type}'.`,
        );
      }
      return {
        type: 'function_call_output',
        call_id: part.tool_call_id,
        output: typeof part.output === 'string' ? part.output : JSON.stringify(part.output),
      };
    });
  }
  return [
    {
      type: 'message',
      role: message.role,
      content: parts.map((part) => mapOpenAIPart(part, message.role === 'assistant')),
    },
  ];
}

function mapOpenAIPart(part: AgentContentPart, assistant: boolean): unknown {
  switch (part.type) {
    case 'text':
      return { type: assistant ? 'output_text' : 'input_text', text: part.text };
    case 'json':
      return { type: 'input_text', text: JSON.stringify(part.value) };
    case 'image':
      return mapImage(part.media, part.detail);
    case 'file':
      return mapFile(part.media, part.filename);
    case 'file_ref':
      return { type: 'input_file', file_id: part.file_id };
    case 'provider_native':
    case 'raw':
      return part.value;
    case 'audio':
    case 'video_frame':
      throw new UnsupportedFeatureError(
        `openai.content.${part.type}`,
        `OpenAI Responses mapping does not support '${part.type}' input.`,
      );
    case 'tool_result':
      throw new UnsupportedFeatureError(
        'openai.nested_tool_result',
        'tool_result must be supplied in a tool-role message.',
      );
  }
}

function mapImage(media: MediaRef, detail?: string): Readonly<Record<string, unknown>> {
  if (media.provider_file_id !== undefined) {
    return { type: 'input_image', file_id: media.provider_file_id, detail };
  }
  if (media.url !== undefined) return { type: 'input_image', image_url: media.url, detail };
  if (media.data_base64 !== undefined) {
    return {
      type: 'input_image',
      image_url: `data:${media.mime_type};base64,${media.data_base64}`,
      detail,
    };
  }
  throw new UnsupportedFeatureError('openai.image_source', 'Image media has no mappable source.');
}

function mapFile(media: MediaRef, filename?: string): Readonly<Record<string, unknown>> {
  if (media.provider_file_id !== undefined) {
    return { type: 'input_file', file_id: media.provider_file_id };
  }
  if (media.url !== undefined) return { type: 'input_file', file_url: media.url };
  if (media.data_base64 !== undefined) {
    return {
      type: 'input_file',
      filename,
      file_data: `data:${media.mime_type};base64,${media.data_base64}`,
    };
  }
  throw new UnsupportedFeatureError('openai.file_source', 'File media has no mappable source.');
}

function mapOpenAIItem(value: unknown, provider: string): RunItem | undefined {
  if (!isRecord(value)) return undefined;
  const nativeType = typeof value.type === 'string' ? value.type : 'unknown';
  const type = itemType(nativeType);
  return createRunItem({
    id: typeof value.id === 'string' ? value.id : undefined,
    type,
    provider,
    status: normalizeItemStatus(value.status),
    data:
      nativeType === 'function_call'
        ? {
            name: value.name,
            call_id: value.call_id ?? value.id,
            arguments: value.arguments ?? {},
          }
        : { ...value },
    raw: value,
  });
}

function itemType(type: string): RunItemType {
  if (type === 'message') return 'message';
  if (type === 'reasoning') return 'reasoning';
  if (type === 'function_call') return 'function_call';
  if (type === 'mcp_list_tools') return 'mcp_list_tools';
  if (type === 'mcp_call') return 'mcp_call';
  if (type === 'mcp_approval_request') return 'mcp_approval_request';
  if (type === 'tool_search_call') return 'tool_search_call';
  if (type.endsWith('_call')) return 'hosted_tool_call';
  return type;
}

function normalizeItemStatus(value: unknown): RunItem['status'] {
  return value === 'created' ||
    value === 'in_progress' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'requires_action'
    ? value
    : undefined;
}

function extractResponseText(response: Readonly<Record<string, unknown>>): string {
  if (typeof response.output_text === 'string') return response.output_text;
  if (!Array.isArray(response.output)) return '';
  const output: readonly unknown[] = response.output;
  const parts: unknown[] = [];
  for (const item of output) {
    if (isRecord(item) && Array.isArray(item.content)) {
      const content: readonly unknown[] = item.content;
      parts.push(...content);
    }
  }
  return parts
    .map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : ''))
    .join('');
}

function mapCache(body: Record<string, unknown>, cache: unknown): void {
  if (!isRecord(cache)) return;
  if (typeof cache.key === 'string') body.prompt_cache_key = cache.key;
  if (typeof cache.retention === 'string') body.prompt_cache_retention = cache.retention;
}

function mapCompaction(value: unknown): unknown {
  if (!isRecord(value)) return undefined;
  return value.strategy === 'auto' || value.strategy === 'disabled' ? value.strategy : undefined;
}

function mergeExtra(
  body: Record<string, unknown>,
  extra: Readonly<Record<string, unknown>> | undefined,
): void {
  if (extra === undefined) return;
  for (const [key, value] of Object.entries(extra)) {
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
