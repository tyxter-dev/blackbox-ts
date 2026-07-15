import { contentToText } from '../../core/content.js';
import {
  textCompletionCapabilityProfile,
  type CapabilityProfile,
} from '../../core/capabilities.js';
import type { AgentModelProvider, ProviderModel, TurnRequest, TurnResult } from '../base.js';
import { normalizeTurnRequest, streamTurnFromResult } from '../base.js';
import { tokenUsage } from '../../core/usage.js';

export class EchoModelProvider implements AgentModelProvider {
  readonly id = 'echo';
  readonly defaultModel = 'echo';

  capabilities(model = this.defaultModel): CapabilityProfile {
    const profile = textCompletionCapabilityProfile(this.id, model);
    return {
      ...profile,
      summary: { ...profile.summary, supports_streaming_events: true },
      metadata: { deterministic: true, offline: true },
    };
  }

  models(): readonly ProviderModel[] {
    return [
      {
        id: this.defaultModel,
        provider: this.id,
        display_name: 'Echo',
        capabilities: this.capabilities().summary,
        metadata: { deterministic: true },
      },
    ];
  }

  async turn(request: TurnRequest): Promise<TurnResult> {
    const normalized = normalizeTurnRequest(request);
    const outputText =
      typeof normalized.input === 'string'
        ? normalized.input
        : normalized.input.map((message) => contentToText(message.content)).join('\n');
    return {
      output_text: outputText,
      usage: tokenUsage(countWords(outputText), countWords(outputText)),
      provider: this.id,
      model: normalized.model,
      raw_response: { echo: outputText },
    };
  }

  async *streamTurn(request: TurnRequest) {
    yield* streamTurnFromResult(this.id, request, () => this.turn(request));
  }
}

function countWords(value: string): number {
  return Math.max(1, value.trim().split(/\s+/).filter(Boolean).length);
}
