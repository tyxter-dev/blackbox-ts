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
import { usageFromGemini, type ModelUsage } from '../../core/usage.js';
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

export interface GeminiProviderConfig {
  readonly apiKey: string;
  readonly model: string;
  readonly apiBase?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly capabilities?: (model?: string) => CapabilityProfile;
  readonly models?: readonly ProviderModel[];
}

export interface GeminiGenerateContentRequest extends Readonly<Record<string, unknown>> {
  readonly contents: readonly unknown[];
}

export class GeminiGenerateContentProvider implements AgentModelProvider {
  readonly id = 'google';
  readonly defaultModel: string;

  private readonly apiKey: string;
  private readonly apiBase: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs?: number;
  private readonly maxRetries: number;
  private readonly capabilityFactory: (model?: string) => CapabilityProfile;
  private readonly configuredModels: readonly ProviderModel[];

  constructor(config: GeminiProviderConfig) {
    this.apiKey = config.apiKey;
    this.defaultModel = config.model;
    this.apiBase = stripTrailingSlash(
      config.apiBase ?? 'https://generativelanguage.googleapis.com/v1beta',
    );
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs;
    this.maxRetries = config.maxRetries ?? 2;
    this.capabilityFactory = config.capabilities ?? geminiGenerateContentCapabilityProfile;
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

  buildGenerateContentRequest(input: TurnRequest): {
    readonly url: string;
    readonly body: GeminiGenerateContentRequest;
    readonly headers: Readonly<Record<string, string>>;
  } {
    const request = normalizeTurnRequest(input);
    const mapped = mapGeminiInput(request.input, request.instructions);
    const body: Record<string, unknown> = {
      contents: [...(request.provider_state?.native_history ?? []), ...mapped.contents],
      systemInstruction: mapped.systemInstruction,
      tools: mapGeminiTools(request),
      toolConfig: mapGeminiToolChoice(request.tool_choice),
      generationConfig: mapGenerationConfig(request),
      cachedContent: mapCachedContent(request.cache),
    };
    mergeExtra(body, request.extra);
    removeUndefined(body);
    return {
      url: `${this.apiBase}/models/${encodeURIComponent(request.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(this.apiKey)}`,
      body: body as GeminiGenerateContentRequest,
      headers: { 'content-type': 'application/json' },
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
    const built = this.buildGenerateContentRequest(request);
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
      const mapper = new GeminiEventMapper(request);
      let finalRaw: unknown;
      if (response.headers.get('content-type')?.includes('text/event-stream')) {
        for await (const message of decodeSSE(response, timeout.signal)) {
          const payload = parseSSEJson(message);
          if (payload === undefined) continue;
          finalRaw = payload;
          yield* mapper.map(payload);
        }
      } else {
        const { json } = await readJson(response);
        finalRaw = json;
        yield* mapper.map(json);
      }
      yield mapper.complete(finalRaw);
    } finally {
      timeout.cancel();
    }
  }
}

export class GeminiProvider extends GeminiGenerateContentProvider {}

export function createGeminiProvider(config: GeminiProviderConfig): GeminiProvider {
  return new GeminiProvider(config);
}

class GeminiEventMapper {
  private started = false;
  private text = '';
  private usage: ModelUsage = usageFromGemini(undefined);
  private readonly items: RunItem[] = [];
  private readonly nativeParts: unknown[] = [];
  private readonly thoughtSignatures: string[] = [];
  private readonly sources: unknown[] = [];

  constructor(private readonly request: TurnRequest) {}

  *map(payload: unknown): Iterable<AgentEvent> {
    if (!isRecord(payload)) throw new ProviderExecutionError('google', 502, payload);
    if (!this.started) {
      this.started = true;
      yield this.event(AgentEventTypes.MODEL_REQUEST_STARTED, payload, {
        model: this.request.model,
      });
    }
    if (payload.usageMetadata !== undefined) this.usage = usageFromGemini(payload.usageMetadata);
    const candidates: readonly unknown[] = Array.isArray(payload.candidates)
      ? payload.candidates
      : [];
    for (const candidate of candidates) {
      if (!isRecord(candidate)) continue;
      if (candidate.groundingMetadata !== undefined) this.sources.push(candidate.groundingMetadata);
      const content = isRecord(candidate.content) ? candidate.content : {};
      const parts: readonly unknown[] = Array.isArray(content.parts) ? content.parts : [];
      for (const part of parts) yield* this.mapPart(part, payload);
    }
    if (isRecord(payload.error)) throw new ProviderExecutionError('google', 502, payload.error);
  }

  complete(raw: unknown): AgentEvent {
    const state = createProviderState({
      provider: 'google',
      model: this.request.model,
      native_history: [
        {
          role: 'model',
          parts: this.nativeParts,
        },
      ],
      reasoning_state: { thought_signatures: this.thoughtSignatures },
      tool_state: {
        function_call_ids: this.items
          .filter((item) => item.type === 'function_call')
          .map((item) => item.data.call_id),
        sources: this.sources,
      },
    });
    return this.event(AgentEventTypes.MODEL_COMPLETED, raw, {
      output_text: this.text,
      usage: this.usage,
      items: this.items,
      provider_state: state,
      sources: this.sources,
    });
  }

  private *mapPart(part: unknown, raw: unknown): Iterable<AgentEvent> {
    if (!isRecord(part)) return;
    this.nativeParts.push(part);
    if (typeof part.thoughtSignature === 'string')
      this.thoughtSignatures.push(part.thoughtSignature);
    if (typeof part.text === 'string') {
      if (part.thought === true) {
        yield this.event(AgentEventTypes.MODEL_REASONING_DELTA, raw, { delta: part.text });
      } else {
        this.text += part.text;
        yield this.event(AgentEventTypes.MODEL_TEXT_DELTA, raw, { delta: part.text });
      }
      return;
    }
    if (isRecord(part.functionCall)) {
      const call = part.functionCall;
      const item = createRunItem({
        id: typeof call.id === 'string' ? call.id : undefined,
        type: 'function_call',
        provider: 'google',
        status: 'completed',
        data: {
          name: call.name,
          call_id: call.id,
          arguments: call.args ?? {},
          thought_signature: part.thoughtSignature,
        },
        raw: part,
      });
      this.items.push(item);
      yield this.event(AgentEventTypes.MODEL_ITEM_CREATED, raw, { item }, item.id);
      yield this.event(AgentEventTypes.MODEL_ITEM_COMPLETED, raw, { item }, item.id);
      return;
    }
    if (isRecord(part.functionResponse)) {
      const response = part.functionResponse;
      const item = createRunItem({
        id: typeof response.id === 'string' ? response.id : undefined,
        type: 'function_result',
        provider: 'google',
        status: 'completed',
        data: { name: response.name, call_id: response.id, output: response.response },
        raw: part,
      });
      this.items.push(item);
      yield this.event(AgentEventTypes.MODEL_ITEM_COMPLETED, raw, { item }, item.id);
      return;
    }
    yield this.event('gemini.part', raw, { part });
  }

  private event(
    type: string,
    raw: unknown,
    data: Readonly<Record<string, unknown>>,
    itemId?: string,
  ): AgentEvent {
    return createAgentEvent({
      type,
      provider: 'google',
      model: this.request.model,
      trace_id: this.request.trace_id,
      item_id: itemId,
      data,
      raw,
    });
  }
}

export function geminiGenerateContentCapabilityProfile(model?: string): CapabilityProfile {
  const gemini3 = model?.startsWith('gemini-3') === true;
  return {
    provider: 'google',
    model,
    summary: {
      supports_streaming_events: true,
      supports_function_tools: true,
      supports_parallel_tool_calls: true,
      supports_hosted_tools: true,
      supports_mcp: false,
      supports_workspaces: false,
      supports_provider_state: true,
      supports_structured_output: true,
    },
    tools: {
      function_tools: capability('supported'),
      parallel_tool_calls: capability('supported'),
    },
    hosted_tools: {
      hosted_tools: capability('unsupported'),
      web_search: capability('supported'),
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
      parallel_tool_calls: capability('unsupported'),
      reasoning_effort: capability('supported', {
        supported_values: ['minimal', 'low', 'medium', 'high'],
      }),
      cache: capability('supported'),
      extra: capability('passthrough'),
    },
    state: {
      provider_stateful: capability('supported'),
      stateless_replay: capability('supported'),
    },
    integrations: {
      mcp: capability('unsupported'),
      workspace: capability('unsupported'),
    },
    constraints: gemini3
      ? []
      : [
          {
            all_of: ['tools.function_tools', 'output.provider_native'],
            reason: 'Structured output with function tools requires a Gemini 3 model.',
          },
        ],
    source: 'blackbox-ts:gemini-generate-content',
  };
}

export function extractGeminiText(json: unknown): string {
  if (!isRecord(json) || !Array.isArray(json.candidates)) return '';
  const candidates: readonly unknown[] = json.candidates;
  const first = candidates[0];
  if (!isRecord(first) || !isRecord(first.content) || !Array.isArray(first.content.parts)) {
    return '';
  }
  const parts: readonly unknown[] = first.content.parts;
  return parts
    .map((part) =>
      isRecord(part) && part.thought !== true && typeof part.text === 'string' ? part.text : '',
    )
    .join('');
}

function mapGeminiInput(
  input: TurnRequest['input'],
  instructions?: string,
): {
  readonly systemInstruction?: Readonly<Record<string, unknown>>;
  readonly contents: readonly unknown[];
} {
  const system: unknown[] = instructions === undefined ? [] : [{ text: instructions }];
  if (typeof input === 'string') {
    return {
      systemInstruction: system.length === 0 ? undefined : { parts: system },
      contents: [{ role: 'user', parts: [{ text: input }] }],
    };
  }
  const contents: unknown[] = [];
  for (const message of input) {
    if (message.role === 'system') {
      system.push(...mapGeminiMessageParts(message));
      continue;
    }
    contents.push({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: mapGeminiMessageParts(message),
    });
  }
  return {
    systemInstruction: system.length === 0 ? undefined : { parts: system },
    contents,
  };
}

function mapGeminiMessageParts(message: AgentMessage): readonly unknown[] {
  if (typeof message.content === 'string') {
    if (message.role === 'tool' && message.tool_call_id !== undefined) {
      return [
        {
          functionResponse: {
            id: message.tool_call_id,
            name: message.name ?? 'tool',
            response: { output: message.content },
          },
        },
      ];
    }
    return [{ text: message.content }];
  }
  return message.content.map(mapGeminiPart);
}

function mapGeminiPart(part: AgentContentPart): unknown {
  switch (part.type) {
    case 'text':
      return { text: part.text };
    case 'json':
      return { text: JSON.stringify(part.value) };
    case 'image':
    case 'audio':
    case 'file':
      return mapGeminiMedia(part.media);
    case 'file_ref':
      return { fileData: { fileUri: part.file_id, mimeType: part.media_type } };
    case 'tool_result':
      return {
        functionResponse: {
          id: part.tool_call_id,
          name: part.tool_call_id,
          response: { output: part.output, is_error: part.is_error },
        },
      };
    case 'provider_native':
    case 'raw':
      return part.value;
    case 'video_frame':
      throw new UnsupportedFeatureError(
        'google.content.video_frame',
        'Gemini GenerateContent mapping does not accept individual video_frame parts.',
      );
  }
}

function mapGeminiMedia(media: MediaRef): Readonly<Record<string, unknown>> {
  if (media.url !== undefined) {
    return { fileData: { fileUri: media.url, mimeType: media.mime_type } };
  }
  if (media.provider_file_id !== undefined) {
    return { fileData: { fileUri: media.provider_file_id, mimeType: media.mime_type } };
  }
  if (media.data_base64 !== undefined) {
    return { inlineData: { mimeType: media.mime_type, data: media.data_base64 } };
  }
  throw new UnsupportedFeatureError('google.media_source', 'Media has no mappable source.');
}

function mapGeminiTools(request: TurnRequest): readonly unknown[] | undefined {
  const tools: unknown[] = [];
  if ((request.tools?.length ?? 0) > 0) {
    tools.push({
      functionDeclarations: request.tools?.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema ?? { type: 'object', properties: {} },
      })),
    });
  }
  for (const hosted of request.hosted_tools ?? []) {
    if (hosted.type === 'web_search') tools.push({ googleSearch: hosted.config ?? {} });
    else if (hosted.type === 'raw') tools.push({ ...(hosted.config ?? {}) });
  }
  return tools.length === 0 ? undefined : tools;
}

function mapGeminiToolChoice(value: TurnRequest['tool_choice']): unknown {
  if (value === undefined) return undefined;
  if (value === 'auto') return { functionCallingConfig: { mode: 'AUTO' } };
  if (value === 'none') return { functionCallingConfig: { mode: 'NONE' } };
  if (value === 'required') return { functionCallingConfig: { mode: 'ANY' } };
  return { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [value] } };
}

function mapGenerationConfig(request: TurnRequest): Readonly<Record<string, unknown>> | undefined {
  const schema =
    request.output?.strategy === 'provider_native'
      ? request.output.schema
      : request.response_format?.type === 'json_schema'
        ? request.response_format.schema
        : undefined;
  const value: Record<string, unknown> = {
    maxOutputTokens: request.max_tokens ?? request.max_output_tokens,
    temperature: request.temperature,
    topP: request.top_p,
    responseMimeType: schema === undefined ? undefined : 'application/json',
    responseJsonSchema: schema,
    thinkingConfig:
      request.reasoning_effort === undefined
        ? undefined
        : { thinkingLevel: request.reasoning_effort.toUpperCase() },
  };
  removeUndefined(value);
  return Object.keys(value).length === 0 ? undefined : value;
}

function mapCachedContent(cache: unknown): string | undefined {
  if (!isRecord(cache)) return undefined;
  if (typeof cache.cached_content === 'string') return cache.cached_content;
  return typeof cache.name === 'string' ? cache.name : undefined;
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
