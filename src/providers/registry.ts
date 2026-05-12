import { ProviderNotRegisteredError } from '../core/errors.js';
import { parseProviderModelRef } from '../core/refs.js';
import type { ModelProvider } from './base.js';

export class ProviderRegistry {
  private readonly modelProviders = new Map<string, ModelProvider>();

  register(provider: ModelProvider, aliases: readonly string[] = []): void {
    this.registerModelProvider(provider, aliases);
  }

  registerModelProvider(provider: ModelProvider, aliases: readonly string[] = []): void {
    this.modelProviders.set(provider.id, provider);
    for (const alias of aliases) {
      this.modelProviders.set(alias, provider);
    }
  }

  get(provider: string): ModelProvider {
    return this.getModelProvider(provider);
  }

  getModelProvider(provider: string): ModelProvider {
    const found = this.modelProviders.get(provider);
    if (!found) {
      throw new ProviderNotRegisteredError(provider, this.knownModelProviders());
    }
    return found;
  }

  resolveModelProvider(
    ref: string,
    fallbackProvider?: string,
  ): {
    readonly provider: ModelProvider;
    readonly provider_id: string;
    readonly model: string;
  } {
    const parsed = parseProviderModelRef(ref, fallbackProvider);
    return {
      provider: this.getModelProvider(parsed.provider),
      provider_id: parsed.provider,
      model: parsed.model,
    };
  }

  knownModelProviders(): string[] {
    return [...this.modelProviders.keys()].sort();
  }

  list(): readonly ModelProvider[] {
    return [...new Set(this.modelProviders.values())];
  }
}

export class AgentProviderRegistry extends ProviderRegistry {}
