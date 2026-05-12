import { assertTurnRequestCapabilities, textCompletionCapabilityProfile } from '../../core/capabilities.js';
import type { CapabilityProfile } from '../../core/capabilities.js';
import { usageFromAnthropic } from '../../core/usage.js';
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
import { splitSystemAndChatMessages } from '../message-mapping.js';

export interface AnthropicProviderConfig {
  readonly apiKey: string;
  readonly model: string;
  readonly apiBase?: string;
  readonly anthropicVersion?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly capabilities?: (model?: string) => CapabilityProfile;
  readonly models?: readonly ProviderModel[];
}

export interface AnthropicMessagesRequest {
  readonly model: string;
  readonly system?: string;
  readonly messages: ReadonlyArray<{ readonly role: 'user' | 'assistant'; readonly content: string }>;
  readonly max_tokens: number;
  readonly temperature?: number;
  readonly top_p?: number;
}

export class AnthropicProvider implements AgentModelProvider {
  readonly id = 'anthropic';
  readonly defaultModel: string;

  private readonly apiKey: string;
  private readonly apiBase: string;
  private readonly anthropicVersion: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number | undefined;
  private readonly capabilityFactory: (model?: string) => CapabilityProfile;
  private readonly configuredModels: readonly ProviderModel[];

  constructor(config: AnthropicProviderConfig) {
    this.apiKey = config.apiKey;
    this.defaultModel = config.model;
    this.apiBase = stripTrailingSlash(config.apiBase ?? 'https://api.anthropic.com');
    this.anthropicVersion = config.anthropicVersion ?? '2023-06-01';
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs;
    this.capabilityFactory = config.capabilities ?? ((model) => textCompletionCapabilityProfile('anthropic', model));
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

  buildMessagesRequest(request: TurnRequest): {
    readonly url: string;
    readonly body: AnthropicMessagesRequest;
    readonly headers: Readonly<Record<string, string>>;
  } {
    const mapped = splitSystemAndChatMessages(request.input, request.instructions);
    return {
      url: `${this.apiBase}/v1/messages`,
      body: {
        model: request.model,
        system: mapped.system,
        messages: mapped.messages,
        max_tokens: request.max_tokens ?? request.max_output_tokens ?? 512,
        temperature: request.temperature,
        top_p: request.top_p,
      },
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': this.anthropicVersion,
      },
    };
  }

  async turn(request: TurnRequest): Promise<TurnResult> {
    const profile = this.capabilities(request.model);
    assertTurnRequestCapabilities(this.id, request, profile);

    const built = this.buildMessagesRequest(request);
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
      return this.parseMessagesResponse(request, json);
    } finally {
      timeout.cancel();
    }
  }

  protected parseMessagesResponse(request: TurnRequest, json: unknown): TurnResult {
    const usage = isRecord(json) ? usageFromAnthropic(json.usage) : usageFromAnthropic(undefined);
    const model = isRecord(json) && typeof json.model === 'string' ? json.model : request.model;
    const result: TurnResult = {
      output_text: extractAnthropicText(json),
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
}

export function createAnthropicProvider(config: AnthropicProviderConfig): AnthropicProvider {
  return new AnthropicProvider(config);
}

export function extractAnthropicText(json: unknown): string {
  if (!isRecord(json) || !Array.isArray(json.content)) return '';
  return json.content
    .map((block) => (isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join('');
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
