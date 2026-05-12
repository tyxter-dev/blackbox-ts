import { describe, expect, it } from 'vitest';
import {
  AgentProviderRegistry,
  FakeModelProvider,
  ProviderModelCatalog,
  ProviderNotRegisteredError,
  ProviderRegistry,
} from '../../src/index.js';

describe('provider registry', () => {
  it('registers providers, aliases, and resolves provider:model refs', () => {
    const registry = new ProviderRegistry();
    const provider = new FakeModelProvider({ id: 'openai', model: 'gpt-4.1-mini' });
    registry.registerModelProvider(provider, ['oa']);

    expect(registry.getModelProvider('oa')).toBe(provider);
    expect(registry.resolveModelProvider('oa:gpt-4.1-mini')).toEqual({
      provider,
      provider_id: 'oa',
      model: 'gpt-4.1-mini',
    });
    expect(registry.knownModelProviders()).toEqual(['oa', 'openai']);
  });

  it('keeps the legacy AgentProviderRegistry constructor export', () => {
    const registry = new AgentProviderRegistry();
    expect(registry.knownModelProviders()).toEqual([]);
  });

  it('throws typed errors for unknown providers', () => {
    const registry = new ProviderRegistry();
    expect(() => registry.getModelProvider('missing')).toThrow(ProviderNotRegisteredError);
  });
});

describe('provider model catalog', () => {
  it('resolves model aliases to canonical ids', () => {
    const catalog = new ProviderModelCatalog([
      {
        provider: 'anthropic',
        id: 'claude-sonnet-4-5',
        aliases: ['sonnet'],
        status: 'active',
      },
    ]);

    expect(catalog.resolve('anthropic', 'sonnet')).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
    });
    expect(catalog.get('anthropic', 'sonnet').id).toBe('claude-sonnet-4-5');
  });
});
