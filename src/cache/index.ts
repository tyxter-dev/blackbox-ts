import type { ModelUsage, ModelUsageInput } from '../core/usage.js';
import { modelUsage } from '../core/usage.js';
import type { ProviderCacheEntry, ProviderCacheStore } from '../persistence/stores.js';
import { createProviderCacheEntry, InMemoryProviderCacheStore } from '../persistence/stores.js';

export interface ProviderCacheUsage {
  readonly provider: string;
  readonly model: string;
  readonly requested: boolean;
  readonly hit: boolean;
  readonly hit_ratio?: number;
  readonly input_tokens: number;
  readonly cached_input_tokens: number;
  readonly cache_read_input_tokens: number;
  readonly cache_creation_input_tokens: number;
  readonly key?: string;
  readonly provider_cache_id?: string;
  readonly strategy?: string;
  readonly ttl?: string;
}

export interface ProviderCacheUsageInput {
  readonly provider: string;
  readonly model: string;
  readonly usage?: ModelUsageInput;
  readonly requested?: boolean;
  readonly key?: string;
  readonly provider_cache_id?: string;
  readonly strategy?: string;
  readonly ttl?: string;
}

/** Per-result prompt/context cache metrics, or undefined when caching was neither requested nor observed. */
export function cacheUsageFromUsage(
  input: ProviderCacheUsageInput,
): ProviderCacheUsage | undefined {
  const usage = modelUsage(input.usage ?? {});
  const requested = input.requested ?? false;
  if (
    !requested &&
    usage.cached_input_tokens === 0 &&
    usage.cache_read_input_tokens === 0 &&
    usage.cache_creation_input_tokens === 0
  ) {
    return undefined;
  }
  return {
    provider: input.provider,
    model: input.model,
    requested,
    hit: cacheUsageHit(usage),
    hit_ratio: cacheUsageHitRatio(usage),
    input_tokens: usage.input_tokens,
    cached_input_tokens: usage.cached_input_tokens,
    cache_read_input_tokens: usage.cache_read_input_tokens,
    cache_creation_input_tokens: usage.cache_creation_input_tokens,
    key: input.key,
    provider_cache_id: input.provider_cache_id,
    strategy: input.strategy,
    ttl: input.ttl,
  };
}

function cacheUsageHit(usage: ModelUsage): boolean {
  if (usage.cache_read_input_tokens > 0) return true;
  return usage.cached_input_tokens > 0 && usage.cache_creation_input_tokens === 0;
}

function cacheUsageHitRatio(usage: ModelUsage): number | undefined {
  if (usage.input_tokens <= 0) return undefined;
  // Cache writes alone do not count as hits: once either split counter is
  // non-zero, only reads count. The combined counter is the legacy fallback for
  // usage whose split counters are both zero; nonpositive input leaves the
  // ratio absent.
  if (usage.cache_read_input_tokens !== 0 || usage.cache_creation_input_tokens !== 0) {
    return usage.cache_read_input_tokens / usage.input_tokens;
  }
  return usage.cached_input_tokens / usage.input_tokens;
}

export interface CacheStats {
  readonly hits: number;
  readonly misses: number;
  readonly writes: number;
  readonly invalidations: number;
  readonly cached_tokens: number;
}

export class ProviderCacheRuntime {
  private hits = 0;
  private misses = 0;
  private writes = 0;
  private invalidations = 0;
  private cachedTokens = 0;

  constructor(readonly store: ProviderCacheStore = new InMemoryProviderCacheStore()) {}

  async get<T = unknown>(key: string): Promise<ProviderCacheEntry<T> | undefined> {
    const entry = await this.store.get<T>(key);
    if (entry === undefined) this.misses += 1;
    else this.hits += 1;
    return entry;
  }

  async set<T>(
    key: string,
    provider: string,
    value: T,
    options: {
      readonly ttl_ms?: number;
      readonly cached_tokens?: number;
      readonly metadata?: Readonly<Record<string, unknown>>;
    } = {},
  ): Promise<void> {
    await this.store.set(createProviderCacheEntry(key, provider, value, options));
    this.writes += 1;
    this.cachedTokens += options.cached_tokens ?? 0;
  }

  async invalidate(key: string): Promise<boolean> {
    const deleted = await this.store.delete(key);
    if (deleted) this.invalidations += 1;
    return deleted;
  }

  async clear(provider?: string): Promise<number> {
    const count = await this.store.clear(provider);
    this.invalidations += count;
    return count;
  }

  stats(): CacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      writes: this.writes,
      invalidations: this.invalidations,
      cached_tokens: this.cachedTokens,
    };
  }
}
