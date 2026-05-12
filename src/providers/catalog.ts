import { AgentRuntimeError } from '../core/errors.js';
import type { ProviderModel } from './base.js';

export class ProviderModelCatalog {
  private readonly modelsByKey = new Map<string, ProviderModel>();
  private readonly aliases = new Map<string, string>();

  constructor(models: readonly ProviderModel[] = []) {
    for (const model of models) {
      this.add(model);
    }
  }

  add(model: ProviderModel): void {
    const key = modelKey(model.provider, model.id);
    this.modelsByKey.set(key, model);
    for (const alias of model.aliases ?? []) {
      this.aliases.set(modelKey(model.provider, alias), key);
    }
  }

  get(provider: string, model: string): ProviderModel {
    const key = this.resolveKey(provider, model);
    const found = this.modelsByKey.get(key);
    if (!found) {
      throw new AgentRuntimeError(`Unknown model '${provider}:${model}'.`, {
        code: 'unknown_model',
      });
    }
    return found;
  }

  has(provider: string, model: string): boolean {
    return this.modelsByKey.has(this.resolveKey(provider, model));
  }

  list(provider?: string): readonly ProviderModel[] {
    const all = [...this.modelsByKey.values()];
    return provider ? all.filter((model) => model.provider === provider) : all;
  }

  resolve(provider: string, model: string): { readonly provider: string; readonly model: string } {
    const found = this.get(provider, model);
    return { provider: found.provider, model: found.id };
  }

  private resolveKey(provider: string, model: string): string {
    const key = modelKey(provider, model);
    return this.aliases.get(key) ?? key;
  }
}

export function modelKey(provider: string, model: string): string {
  return `${provider}:${model}`;
}
