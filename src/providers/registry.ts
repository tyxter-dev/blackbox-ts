import { ProviderNotRegisteredError } from '../core/errors.js';
import { parseProviderModelRef } from '../core/refs.js';
import type { AgentProvider } from './agent.js';
import type { ModelProvider } from './base.js';
import type { RealtimeProvider } from './realtime.js';

export class ProviderRegistry {
  private readonly modelProviders = new Map<string, ModelProvider>();
  private readonly agentProviders = new Map<string, AgentProvider>();
  private readonly realtimeProviders = new Map<string, RealtimeProvider>();

  register(provider: ModelProvider, aliases: readonly string[] = []): void {
    this.registerModelProvider(provider, aliases);
  }

  registerModelProvider(provider: ModelProvider, aliases: readonly string[] = []): void {
    registerWithAliases(this.modelProviders, provider.id, provider, aliases);
  }

  registerAgentProvider(provider: AgentProvider, aliases: readonly string[] = []): void {
    registerWithAliases(this.agentProviders, provider.id, provider, aliases);
  }

  registerRealtimeProvider(provider: RealtimeProvider, aliases: readonly string[] = []): void {
    registerWithAliases(this.realtimeProviders, provider.id, provider, aliases);
  }

  get(provider: string): ModelProvider {
    return this.getModelProvider(provider);
  }

  getModelProvider(provider: string): ModelProvider {
    return getRegistered(this.modelProviders, provider);
  }

  getAgentProvider(provider: string): AgentProvider {
    return getRegistered(this.agentProviders, provider);
  }

  getRealtimeProvider(provider: string): RealtimeProvider {
    return getRegistered(this.realtimeProviders, provider);
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
    return sortedKeys(this.modelProviders);
  }

  knownAgentProviders(): string[] {
    return sortedKeys(this.agentProviders);
  }

  knownRealtimeProviders(): string[] {
    return sortedKeys(this.realtimeProviders);
  }

  list(): readonly ModelProvider[] {
    return uniqueValues(this.modelProviders);
  }

  listAgentProviders(): readonly AgentProvider[] {
    return uniqueValues(this.agentProviders);
  }

  listRealtimeProviders(): readonly RealtimeProvider[] {
    return uniqueValues(this.realtimeProviders);
  }

  async close(): Promise<void> {
    const providers = new Set<ModelProvider | AgentProvider | RealtimeProvider>([
      ...this.modelProviders.values(),
      ...this.agentProviders.values(),
      ...this.realtimeProviders.values(),
    ]);
    await Promise.all(
      [...providers].map(async (provider) => {
        await provider.close?.();
      }),
    );
  }
}

/** @deprecated Use ProviderRegistry and its explicit provider namespaces. */
export class AgentProviderRegistry extends ProviderRegistry {}

function registerWithAliases<T>(
  registry: Map<string, T>,
  id: string,
  provider: T,
  aliases: readonly string[],
): void {
  registry.set(id, provider);
  for (const alias of aliases) registry.set(alias, provider);
}

function getRegistered<T>(registry: ReadonlyMap<string, T>, provider: string): T {
  const found = registry.get(provider);
  if (found === undefined) {
    throw new ProviderNotRegisteredError(provider, sortedKeys(registry));
  }
  return found;
}

function sortedKeys<T>(registry: ReadonlyMap<string, T>): string[] {
  return [...registry.keys()].sort();
}

function uniqueValues<T>(registry: ReadonlyMap<string, T>): readonly T[] {
  return [...new Set(registry.values())];
}
