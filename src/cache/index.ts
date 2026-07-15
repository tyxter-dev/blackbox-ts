import type { ProviderCacheEntry, ProviderCacheStore } from '../persistence/stores.js';
import { createProviderCacheEntry, InMemoryProviderCacheStore } from '../persistence/stores.js';

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
