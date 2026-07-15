import {
  assertTurnRequestCapabilities,
  textCompletionCapabilityProfile,
} from '../../core/capabilities.js';
import type { CapabilityProfile } from '../../core/capabilities.js';
import { usageFromOpenAI } from '../../core/usage.js';
import type { TokenUsage } from '../../core/usage.js';
import {
  complete as completeTurn,
  turnCompletedEvent,
  turnStartedEvent,
  streamTurnFromResult,
  normalizeTurnRequest,
  type AgentModelProvider,
  type LLMCompletionInput,
  type LLMCompletionResult,
  type ProviderModel,
  type TurnRequest,
  type TurnResult,
} from '../base.js';
import { readJson, stripTrailingSlash, throwProviderError, timeoutSignal } from '../http.js';
import { inputToMessages, type OpenAICompatibleMessage } from '../message-mapping.js';

export interface OpenAICompatibleProviderConfig {
  readonly providerId: string;
  readonly apiKey: string;
  readonly model: string;
  readonly apiBase: string;
  readonly defaultHeaders?: Readonly<Record<string, string>>;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly capabilities?: (model?: string) => CapabilityProfile;
  readonly models?: readonly ProviderModel[];
}

export interface OpenAICompatibleChatRequest {
  readonly model: string;
  readonly messages: readonly OpenAICompatibleMessage[];
  readonly max_tokens?: number;
  readonly temperature?: number;
  readonly top_p?: number;
  readonly stream: false;
}

export class OpenAICompatibleChatProvider implements AgentModelProvider {
  readonly id: string;
  readonly defaultModel: string;

  private readonly apiKey: string;
  private readonly apiBase: string;
  private readonly defaultHeaders: Readonly<Record<string, string>>;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number | undefined;
  private readonly capabilityFactory: (model?: string) => CapabilityProfile;
  private readonly configuredModels: readonly ProviderModel[];

  constructor(config: OpenAICompatibleProviderConfig) {
    this.id = config.providerId;
    this.defaultModel = config.model;
    this.apiKey = config.apiKey;
    this.apiBase = stripTrailingSlash(config.apiBase);
    this.defaultHeaders = config.defaultHeaders ?? {};
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs;
    this.capabilityFactory =
      config.capabilities ?? ((model) => textCompletionCapabilityProfile(this.id, model));
    this.configuredModels = config.models ?? [];
  }

  capabilities(model?: string): CapabilityProfile {
    return this.capabilityFactory(model ?? this.defaultModel);
  }

  models(): readonly ProviderModel[] {
    return this.configuredModels;
  }

  async complete(input: LLMCompletionInput): Promise<LLMCompletionResult> {
    return completeTurn(this, input);
  }

  buildChatCompletionsRequest(request: TurnRequest): {
    readonly url: string;
    readonly body: OpenAICompatibleChatRequest;
    readonly headers: Readonly<Record<string, string>>;
  } {
    const body: OpenAICompatibleChatRequest = {
      model: request.model,
      messages: inputToMessages(request.input, request.instructions),
      max_tokens: request.max_tokens ?? request.max_output_tokens,
      temperature: request.temperature,
      top_p: request.top_p,
      stream: false,
    };

    return {
      url: `${this.apiBase}/chat/completions`,
      body,
      headers: this.headers(),
    };
  }

  async turn(request: TurnRequest): Promise<TurnResult> {
    request = normalizeTurnRequest(request);
    const profile = this.capabilities(request.model);
    assertTurnRequestCapabilities(this.id, request, profile);

    const built = this.buildChatCompletionsRequest(request);
    const timeout = timeoutSignal(this.timeoutMs);
    try {
      const response = await this.fetchImpl(built.url, {
        method: 'POST',
        headers: built.headers,
        body: JSON.stringify(built.body),
        signal: timeout.signal,
      });
      const { json } = await readJson(response);
      if (!response.ok) {
        throwProviderError(this.id, response.status, json);
      }
      return this.parseChatCompletionsResponse(request, json);
    } finally {
      timeout.cancel();
    }
  }

  async *streamTurn(request: TurnRequest) {
    yield* streamTurnFromResult(this.id, request, () => this.turn(request));
  }

  protected parseChatCompletionsResponse(request: TurnRequest, json: unknown): TurnResult {
    const output = extractOpenAICompatibleText(json);
    const usage = extractUsage(json);
    const model = extractString(json, 'model') ?? request.model;
    const result: TurnResult = {
      output_text: output,
      usage,
      tokens_in: usage.input_tokens,
      tokens_out: usage.output_tokens,
      model,
      provider: this.id,
      raw_response: json,
      events: [],
    };
    return {
      ...result,
      events: [turnStartedEvent(this.id, request), turnCompletedEvent(this.id, request, result)],
    };
  }

  private headers(): Readonly<Record<string, string>> {
    return {
      'content-type': 'application/json',
      authorization: `Bearer ${this.apiKey}`,
      ...this.defaultHeaders,
    };
  }
}

export function extractOpenAICompatibleText(json: unknown): string {
  if (!isRecord(json)) return '';
  const choices: readonly unknown[] = Array.isArray(json.choices) ? json.choices : [];
  const first = choices[0];
  if (!isRecord(first) || !isRecord(first.message)) return '';
  const content = first.message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : ''))
      .filter(Boolean)
      .join('');
  }
  return '';
}

function extractUsage(json: unknown): TokenUsage {
  if (!isRecord(json)) return usageFromOpenAI(undefined);
  return usageFromOpenAI(json.usage);
}

function extractString(json: unknown, key: string): string | undefined {
  if (!isRecord(json)) return undefined;
  const value = json[key];
  return typeof value === 'string' ? value : undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
