import { textCompletionCapabilityProfile, type CapabilityProfile } from '../core/capabilities.js';
import {
  complete as completeTurn,
  type AgentModelProvider,
  type LLMCompletionInput,
  type LLMCompletionResult,
  type ProviderModel,
  type TurnRequest,
  type TurnResult,
  streamTurnFromResult,
  normalizeTurnRequest,
} from '../providers/base.js';
import { modelUsage, tokenUsage, type ModelUsageInput } from '../core/usage.js';
import type { RunItem } from '../core/items.js';
import type { ProviderState } from '../core/state.js';
import type { Artifact } from '../core/artifacts.js';

export interface FakeModelProviderOptions {
  readonly id?: string;
  readonly model?: string;
  readonly outputText?: string;
  readonly capabilities?: (model?: string) => CapabilityProfile;
  readonly models?: readonly ProviderModel[];
}

export class FakeModelProvider implements AgentModelProvider {
  readonly id: string;
  readonly defaultModel: string;
  readonly turns: TurnRequest[] = [];
  readonly completions: LLMCompletionInput[] = [];

  private readonly outputText: string;
  private readonly capabilityFactory: (model?: string) => CapabilityProfile;
  private readonly configuredModels: readonly ProviderModel[];

  constructor(options: FakeModelProviderOptions = {}) {
    this.id = options.id ?? 'fake';
    this.defaultModel = options.model ?? 'fake-model';
    this.outputText = options.outputText ?? 'fake response';
    this.capabilityFactory =
      options.capabilities ?? ((model) => textCompletionCapabilityProfile(this.id, model));
    this.configuredModels = options.models ?? [];
  }

  capabilities(model?: string): CapabilityProfile {
    return this.capabilityFactory(model ?? this.defaultModel);
  }

  models(): readonly ProviderModel[] {
    return this.configuredModels;
  }

  async turn(request: TurnRequest): Promise<TurnResult> {
    request = normalizeTurnRequest(request);
    this.turns.push(request);
    return {
      output_text: this.outputText,
      usage: tokenUsage(countWords(JSON.stringify(request.input)), countWords(this.outputText)),
      model: request.model,
      provider: this.id,
      raw_response: { fake: true },
    };
  }

  async *streamTurn(request: TurnRequest) {
    yield* streamTurnFromResult(this.id, request, () => this.turn(request));
  }

  async complete(input: LLMCompletionInput): Promise<LLMCompletionResult> {
    this.completions.push(input);
    return completeTurn(this, input);
  }
}

export interface ScriptedTurn {
  readonly output_text: string;
  readonly usage?: ModelUsageInput;
  readonly items?: readonly RunItem[];
  readonly provider_state?: ProviderState;
  readonly artifacts?: readonly Artifact[];
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly raw_response?: unknown;
}

export class ScriptedModelProvider extends FakeModelProvider {
  private readonly script: ScriptedTurn[];

  constructor(script: readonly ScriptedTurn[], options: FakeModelProviderOptions = {}) {
    super(options);
    this.script = [...script];
  }

  override async turn(request: TurnRequest): Promise<TurnResult> {
    request = normalizeTurnRequest(request);
    this.turns.push(request);
    const next = this.script.shift();
    if (!next) {
      throw new Error(`Scripted provider '${this.id}' has no remaining turns.`);
    }
    return {
      output_text: next.output_text,
      usage: next.usage === undefined ? undefined : modelUsage(next.usage),
      items: next.items,
      provider_state: next.provider_state,
      artifacts: next.artifacts,
      metadata: next.metadata,
      tokens_in: next.usage?.input_tokens,
      tokens_out: next.usage?.output_tokens,
      model: request.model,
      provider: this.id,
      raw_response: next.raw_response ?? next,
    };
  }
}

function countWords(value: string): number {
  return Math.max(1, value.trim().split(/\s+/).filter(Boolean).length);
}
