import { describe, expect, it } from 'vitest';
import {
  AgentProviderRegistry,
  FakeModelProvider,
  FakeAgentProvider,
  FakeRealtimeProvider,
  ProviderModelCatalog,
  ProviderNotRegisteredError,
  ProviderRegistry,
  bundledProviderModelCatalog,
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

  it('keeps model, agent, and realtime namespaces independent', () => {
    const registry = new ProviderRegistry();
    const model = new FakeModelProvider({ id: 'shared' });
    const agent = new FakeAgentProvider('shared');
    const realtime = new FakeRealtimeProvider('shared');

    registry.registerModelProvider(model);
    registry.registerAgentProvider(agent);
    registry.registerRealtimeProvider(realtime);

    expect(registry.getModelProvider('shared')).toBe(model);
    expect(registry.getAgentProvider('shared')).toBe(agent);
    expect(registry.getRealtimeProvider('shared')).toBe(realtime);
  });

  it('deduplicates provider close hooks registered through aliases', async () => {
    let closes = 0;
    const provider = Object.assign(new FakeModelProvider({ id: 'closable' }), {
      close: () => {
        closes += 1;
      },
    });
    const registry = new ProviderRegistry();
    registry.registerModelProvider(provider, ['alias-1', 'alias-2']);

    await registry.close();
    expect(closes).toBe(1);
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

  it('ships the parent catalog snapshot with lifecycle and provenance', () => {
    const catalog = bundledProviderModelCatalog();

    expect(catalog.resolve('google', 'gemini-2.5-flash')).toEqual({
      provider: 'google',
      model: 'gemini-2.5-flash',
    });
    expect(catalog.get('anthropic', 'claude-sonnet-4-5')).toMatchObject({
      status: 'unknown',
      replacement_model: 'claude-sonnet-4-6',
      source: 'blackbox-bundled',
      catalog_version: '2026-05-06',
    });
  });
});
