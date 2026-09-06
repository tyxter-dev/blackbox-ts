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

export const BUNDLED_PRICING_VERSION = '2026-09-05';

const BUNDLED_PRICING_RETRIEVED_AT = '2026-09-05';
/**
 * Retrieval date for rows the 2026-09-05 refresh did not revisit. Refreshed
 * rows carry `BUNDLED_PRICING_RETRIEVED_AT` instead.
 */
const PRIOR_PRICING_RETRIEVED_AT = '2026-05-06';

export const BUNDLED_PRICING = new PricingCatalog([
  ...openaiPricing(),
  ...anthropicPricing(),
  ...googlePricing(),
  ...xaiPricing(),
]);

function openaiPricing(): readonly PricingEntry[] {
  const current: readonly (readonly [string, number, number])[] = [
    ['gpt-6-astra', 10, 50],
    ['gpt-5.6-sol', 4, 20],
    ['gpt-5.6-terra', 2, 12],
    ['gpt-5.6-luna', 0.2, 1.2],
  ];
  return [
    ...current.map(([model, input, output]) =>
      pricing({
        provider: 'openai',
        model,
        input,
        output,
        cacheRead: input * 0.1,
        cacheCreation: input * 1.25,
        retrievedAt: BUNDLED_PRICING_RETRIEVED_AT,
      }),
    ),
    pricing({ provider: 'openai', model: 'gpt-5.5', input: 5, output: 30, cacheRead: 0.5 }),
    pricing({ provider: 'openai', model: 'gpt-5.4', input: 2.5, output: 15, cacheRead: 0.25 }),
    pricing({
      provider: 'openai',
      model: 'gpt-5.4-mini',
      input: 0.75,
      output: 4.5,
      cacheRead: 0.075,
    }),
  ];
}

function anthropicPricing(): readonly PricingEntry[] {
  const current: readonly (readonly [string, number, number, number])[] = [
    ['claude-fable-5-1', 10, 50, 0.25],
    ['claude-fable-5', 10, 50, 1],
    ['claude-opus-5', 5, 25, 0.5],
    ['claude-sonnet-5', 2, 10, 0.2],
    ['claude-opus-4-8', 5, 25, 0.5],
    ['claude-opus-4-7', 5, 25, 0.5],
    ['claude-opus-4-6', 5, 25, 0.5],
    ['claude-opus-4-5', 5, 25, 0.5],
    ['claude-sonnet-4-6', 3, 15, 0.3],
  ];
  return [
    ...current.map(([model, input, output, cacheRead]) =>
      pricing({
        provider: 'anthropic',
        model,
        input,
        output,
        cacheRead,
        cacheCreation: input * 1.25,
        retrievedAt: BUNDLED_PRICING_RETRIEVED_AT,
      }),
    ),
    ...anthropicAliasPricing(['claude-opus-4-1', 'claude-opus-4-1-20250805'], 15, 75),
    ...anthropicAliasPricing(['claude-opus-4', 'claude-opus-4-20250514'], 15, 75),
    ...anthropicAliasPricing(['claude-sonnet-4-5', 'claude-sonnet-4-5-20250929'], 3, 15),
    ...anthropicAliasPricing(['claude-sonnet-4', 'claude-sonnet-4-20250514'], 3, 15),
    ...anthropicAliasPricing(['claude-haiku-4-5', 'claude-haiku-4-5-20251001'], 1, 5),
    ...anthropicAliasPricing(['claude-haiku-3-5', 'claude-3-5-haiku-20241022'], 0.8, 4),
  ];
}

function googlePricing(): readonly PricingEntry[] {
  return [
    pricing({
      provider: 'google',
      model: 'gemini-3-flash-preview',
      input: 0.5,
      output: 3,
      cacheRead: 0.05,
    }),
    pricing({
      provider: 'google',
      model: 'gemini-2.5-pro',
      input: 1.25,
      output: 10,
      cacheRead: 0.125,
    }),
    pricing({
      provider: 'google',
      model: 'gemini-2.5-flash',
      input: 0.3,
      output: 2.5,
      cacheRead: 0.03,
    }),
    pricing({
      provider: 'google',
      model: 'gemini-2.5-flash-lite',
      input: 0.1,
      output: 0.4,
      cacheRead: 0.01,
    }),
  ];
}

function xaiPricing(): readonly PricingEntry[] {
  const rows: readonly (readonly [string, number, number, number])[] = [
    ['grok-4.6', 2, 0.5, 6],
    ['grok-4.3', 1.25, 0.2, 2.5],
    // Retired in favour of grok-4.3; the redirect bills at the grok-4.3 rates.
    ['grok-4-1-fast-reasoning', 1.25, 0.2, 2.5],
    ['grok-4-1-fast-non-reasoning', 1.25, 0.2, 2.5],
  ];
  return rows.map(([model, input, cacheRead, output]) =>
    pricing({
      provider: 'xai',
      model,
      input,
      output,
      cacheRead,
      retrievedAt: BUNDLED_PRICING_RETRIEVED_AT,
    }),
  );
}

function anthropicAliasPricing(
  models: readonly string[],
  input: number,
  output: number,
): readonly PricingEntry[] {
  return models.map((model) =>
    pricing({
      provider: 'anthropic',
      model,
      input,
      output,
      cacheRead: input * 0.1,
      cacheCreation: input * 1.25,
    }),
  );
}

interface PricingRow {
  readonly provider: string;
  readonly model: string;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheCreation?: number;
  readonly retrievedAt?: string;
}

function pricing(row: PricingRow): PricingEntry {
  return {
    provider: row.provider,
    model: row.model,
    currency: 'USD',
    rates: {
      input_per_million: row.input,
      output_per_million: row.output,
      cache_read_per_million: row.cacheRead,
      cache_creation_per_million: row.cacheCreation ?? row.input,
    },
    source: 'blackbox-bundled',
    version: BUNDLED_PRICING_VERSION,
    effective_at: `${row.retrievedAt ?? PRIOR_PRICING_RETRIEVED_AT}T00:00:00.000Z`,
    metadata: { replaceable: true },
  };
}

function price(tokens: number, rate: number): number {
  return (tokens / 1_000_000) * rate;
}
function key(provider: string, model: string): string {
  return `${provider}:${model}`;
}
