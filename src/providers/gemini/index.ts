import { assertTurnRequestCapabilities, textCompletionCapabilityProfile } from '../../core/capabilities.js';
import type { CapabilityProfile } from '../../core/capabilities.js';
import { contentToText } from '../../core/content.js';
import { usageFromGemini } from '../../core/usage.js';
import {
  complete as completeTurn,
  turnCompletedEvent,
  turnStartedEvent,
  type AgentModelProvider,
  type LLMCompletionInput,
  type LLMCompletionResult,
  type ProviderModel,
  type TurnRequest,
  type TurnResult,
} from '../base.js';
import { readJson, stripTrailingSlash, throwProviderError, timeoutSignal } from '../http.js';

export interface GeminiProviderConfig {
  readonly apiKey: string;
  readonly model: string;
  readonly apiBase?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly capabilities?: (model?: string) => CapabilityProfile;
  readonly models?: readonly ProviderModel[];
}

export interface GeminiGenerateContentRequest {
  readonly contents: ReadonlyArray<{
    readonly role: 'user' | 'model';
    readonly parts: ReadonlyArray<{ readonly text: string }>;
  }>;
  readonly systemInstruction?: {
    readonly parts: ReadonlyArray<{ readonly text: string }>;
  };
  readonly generationConfig?: {
    readonly maxOutputTokens?: number;
    readonly temperature?: number;
    readonly topP?: number;
  };
}

export class GeminiProvider implements AgentModelProvider {
  readonly id = 'gemini';
  readonly defaultModel: string;

  private readonly apiKey: string;
  private readonly apiBase: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number | undefined;
  private readonly capabilityFactory: (model?: string) => CapabilityProfile;
  private readonly configuredModels: readonly ProviderModel[];

  constructor(config: GeminiProviderConfig) {
    this.apiKey = config.apiKey;
    this.defaultModel = config.model;
    this.apiBase = stripTrailingSlash(config.apiBase ?? 'https://generativelanguage.googleapis.com/v1beta');
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs;
    this.capabilityFactory = config.capabilities ?? ((model) => textCompletionCapabilityProfile('gemini', model));
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

  buildGenerateContentRequest(request: TurnRequest): {
    readonly url: string;
    readonly body: GeminiGenerateContentRequest;
    readonly headers: Readonly<Record<string, string>>;
  } {
    const systemParts: string[] = [];
    if (request.instructions) systemParts.push(request.instructions);
    const contents: GeminiGenerateContentRequest['contents'] = typeof request.input === 'string'
      ? [{ role: 'user', parts: [{ text: request.input }] }]
      : request.input.flatMap((message): GeminiGenerateContentRequest['contents'] => {
          const text = contentToText(message.content);
          if (message.role === 'system') {
            systemParts.push(text);
            return [];
          }
          if (message.role === 'assistant') {
            return [{ role: 'model' as const, parts: [{ text }] }];
          }
          if (message.role === 'user') {
            return [{ role: 'user' as const, parts: [{ text }] }];
          }
          return [];
        });

    return {
      url: `${this.apiBase}/models/${encodeURIComponent(request.model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`,
      body: {
        contents,
        systemInstruction: systemParts.length > 0 ? { parts: [{ text: systemParts.join('\n\n') }] } : undefined,
        generationConfig: {
          maxOutputTokens: request.max_tokens ?? request.max_output_tokens,
          temperature: request.temperature,
          topP: request.top_p,
        },
      },
      headers: {
        'content-type': 'application/json',
      },
    };
  }

  async turn(request: TurnRequest): Promise<TurnResult> {
    const profile = this.capabilities(request.model);
    assertTurnRequestCapabilities(this.id, request, profile);

    const built = this.buildGenerateContentRequest(request);
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
      return this.parseGenerateContentResponse(request, json);
    } finally {
      timeout.cancel();
    }
  }

  protected parseGenerateContentResponse(request: TurnRequest, json: unknown): TurnResult {
    const usage = isRecord(json) ? usageFromGemini(json.usageMetadata) : usageFromGemini(undefined);
    const result: TurnResult = {
      output_text: extractGeminiText(json),
      usage,
      tokens_in: usage.input_tokens,
      tokens_out: usage.output_tokens,
      model: request.model,
      provider: this.id,
      raw_response: json,
      events: [],
    };
    return {
      ...result,
      events: [turnStartedEvent(this.id, request), turnCompletedEvent(this.id, request, result)],
    };
  }
}

export function createGeminiProvider(config: GeminiProviderConfig): GeminiProvider {
  return new GeminiProvider(config);
}

export function extractGeminiText(json: unknown): string {
  if (!isRecord(json) || !Array.isArray(json.candidates)) return '';
  const candidates: readonly unknown[] = json.candidates;
  const first = candidates[0];
  if (!isRecord(first) || !isRecord(first.content) || !Array.isArray(first.content.parts)) return '';
  return first.content.parts
    .map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('');
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
