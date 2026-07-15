import { AgentRuntimeError } from '../core/errors.js';
import type { ModelUsage } from '../core/usage.js';

export interface PricingRates {
  readonly input_per_million: number;
  readonly output_per_million: number;
  readonly cache_read_per_million?: number;
  readonly cache_creation_per_million?: number;
}

export interface PricingEntry {
  readonly provider: string;
  readonly model: string;
  readonly currency: 'USD' | (string & {});
  readonly rates: PricingRates;
  readonly source: string;
  readonly version: string;
  readonly effective_at: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface MonetaryEstimate {
  readonly provider_cost: number;
  readonly cost: number;
  readonly user_billable: number;
  readonly currency: string;
  readonly source: string;
  readonly version: string;
  readonly components: Readonly<Record<string, number>>;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface BillingPolicy {
  readonly markup_bps?: number;
  readonly minimum?: number;
  readonly rounding_increment?: number;
}

export class PricingCatalog {
  private readonly entries = new Map<string, PricingEntry>();
  constructor(entries: readonly PricingEntry[] = []) {
    for (const entry of entries) this.set(entry);
  }
  set(entry: PricingEntry): void {
    if (!entry.source || !entry.version) {
      throw new AgentRuntimeError('Pricing entries require source and version provenance.', {
        code: 'pricing_provenance_required',
      });
    }
    this.entries.set(key(entry.provider, entry.model), entry);
  }
  get(provider: string, model: string): PricingEntry | undefined {
    return this.entries.get(key(provider, model));
  }
  list(provider?: string): readonly PricingEntry[] {
    return [...this.entries.values()].filter(
      (entry) => provider === undefined || entry.provider === provider,
    );
  }
  estimate(
    provider: string,
    model: string,
    usage: ModelUsage,
    policy: BillingPolicy = {},
  ): MonetaryEstimate {
    const entry = this.get(provider, model);
    if (entry === undefined) {
      throw new AgentRuntimeError(`No pricing is available for '${provider}:${model}'.`, {
        code: 'pricing_not_found',
      });
    }
    const cacheRead = usage.cache_read_input_tokens;
    const cacheCreation = usage.cache_creation_input_tokens;
    const uncachedInput = Math.max(0, usage.input_tokens - cacheRead - cacheCreation);
    const components = {
      input: price(uncachedInput, entry.rates.input_per_million),
      output: price(usage.output_tokens, entry.rates.output_per_million),
      cache_read: price(
        cacheRead,
        entry.rates.cache_read_per_million ?? entry.rates.input_per_million,
      ),
      cache_creation: price(
        cacheCreation,
        entry.rates.cache_creation_per_million ?? entry.rates.input_per_million,
      ),
    };
    const providerCost = Object.values(components).reduce((total, value) => total + value, 0);
    const markedUp = providerCost * (1 + (policy.markup_bps ?? 0) / 10_000);
    const minimum = Math.max(markedUp, policy.minimum ?? 0);
    const increment = policy.rounding_increment ?? 0.000001;
    const userBillable = Math.ceil(minimum / increment) * increment;
    return {
      provider_cost: providerCost,
      cost: providerCost,
      user_billable: userBillable,
      currency: entry.currency,
      source: entry.source,
      version: entry.version,
      components,
      metadata: { pricing_effective_at: entry.effective_at, policy },
    };
  }
}

export const BUNDLED_PRICING_VERSION = '2026-05-06';
export const BUNDLED_PRICING = new PricingCatalog([
  pricing('openai', 'gpt-5.5', 5, 30, 0.5),
  pricing('openai', 'gpt-5.4', 2.5, 15, 0.25),
  pricing('openai', 'gpt-5.4-mini', 0.75, 4.5, 0.075),
  ...anthropicPricing(['claude-opus-4-1', 'claude-opus-4-1-20250805'], 15, 75),
  ...anthropicPricing(['claude-opus-4', 'claude-opus-4-20250514'], 15, 75),
  ...anthropicPricing(['claude-sonnet-4-5', 'claude-sonnet-4-5-20250929'], 3, 15),
  ...anthropicPricing(['claude-sonnet-4', 'claude-sonnet-4-20250514'], 3, 15),
  ...anthropicPricing(['claude-haiku-4-5', 'claude-haiku-4-5-20251001'], 1, 5),
  ...anthropicPricing(['claude-haiku-3-5', 'claude-3-5-haiku-20241022'], 0.8, 4),
  pricing('google', 'gemini-3-flash-preview', 0.5, 3, 0.05),
  pricing('google', 'gemini-2.5-pro', 1.25, 10, 0.125),
  pricing('google', 'gemini-2.5-flash', 0.3, 2.5, 0.03),
  pricing('google', 'gemini-2.5-flash-lite', 0.1, 0.4, 0.01),
  pricing('xai', 'grok-4-1-fast-reasoning', 0.2, 0.5, 0.2),
  pricing('xai', 'grok-4-1-fast-non-reasoning', 0.2, 0.5, 0.2),
]);

function anthropicPricing(
  models: readonly string[],
  input: number,
  output: number,
): readonly PricingEntry[] {
  return models.map((model) =>
    pricing('anthropic', model, input, output, input * 0.1, input * 1.25),
  );
}

function pricing(
  provider: string,
  model: string,
  input: number,
  output: number,
  cacheRead: number,
  cacheCreation = input,
): PricingEntry {
  return {
    provider,
    model,
    currency: 'USD',
    rates: {
      input_per_million: input,
      output_per_million: output,
      cache_read_per_million: cacheRead,
      cache_creation_per_million: cacheCreation,
    },
    source: 'blackbox-bundled',
    version: BUNDLED_PRICING_VERSION,
    effective_at: '2026-05-06T00:00:00.000Z',
    metadata: { replaceable: true },
  };
}

function price(tokens: number, rate: number): number {
  return (tokens / 1_000_000) * rate;
}
function key(provider: string, model: string): string {
  return `${provider}:${model}`;
}
