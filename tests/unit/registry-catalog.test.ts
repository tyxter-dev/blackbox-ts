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
      status: 'active',
      replacement_model: undefined,
      source: 'blackbox-bundled',
      catalog_version: '2026-09-05',
    });
  });

  it('carries identity, capacity, and provenance for the refreshed model rows', () => {
    const catalog = bundledProviderModelCatalog();
    const capacity: Record<string, { context: number; maxOutput?: number }> = {
      openai: { context: 1_050_000, maxOutput: 128_000 },
      anthropic: { context: 1_000_000, maxOutput: 128_000 },
      xai: { context: 500_000 },
    };

    for (const [provider, ids] of [
      ['openai', ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']],
      [
        'anthropic',
        [
          'claude-fable-5-1',
          'claude-fable-5',
          'claude-opus-5',
          'claude-sonnet-5',
          'claude-opus-4-8',
        ],
      ],
      ['xai', ['grok-4.6']],
    ] as const) {
      for (const id of ids) {
        const model = catalog.get(provider, id);
        expect(model.status).toBe('active');
        expect(model.retrieved_at).toBe('2026-09-05');
        expect(model.context_window).toBe(capacity[provider]?.context);
        expect(model.max_output_tokens).toBe(capacity[provider]?.maxOutput);
        expect(model.source_url).toBeTruthy();
      }
    }

    expect(catalog.get('openai', 'gpt-6-astra').metadata).toMatchObject({
      knowledge_cutoff: '2026-04-30',
      max_input_tokens: 922_000,
      availability: 'account_access_dependent',
    });
    expect(catalog.get('openai', 'gpt-5.6-sol').metadata?.availability).toBeUndefined();
    expect(catalog.get('anthropic', 'claude-fable-5-1').metadata).toMatchObject({
      thinking: 'adaptive',
      thinking_always_on: true,
      reasoning_efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    });
    expect(catalog.get('anthropic', 'claude-opus-4-8').metadata).toMatchObject({
      thinking: 'adaptive',
      thinking_default: 'disabled',
    });
    expect(
      catalog.get('anthropic', 'claude-opus-4-8').metadata?.thinking_always_on,
    ).toBeUndefined();

    expect(catalog.get('openai', 'gpt-5.6').id).toBe('gpt-5.6-sol');
    expect(catalog.get('google', 'gemini-2.5-flash').retrieved_at).toBe('2026-05-06');
  });

  it('marks retired Anthropic and xAI rows with replacements and redirects', () => {
    const catalog = bundledProviderModelCatalog();

    for (const [id, replacement] of [
      ['claude-opus-4-1', 'claude-opus-4-8'],
      ['claude-opus-4', 'claude-opus-4-8'],
      ['claude-sonnet-4', 'claude-sonnet-4-6'],
      ['claude-haiku-3-5', 'claude-haiku-4-5'],
    ] as const) {
      const model = catalog.get('anthropic', id);
      expect(model.id).toBe(id);
      expect(model.status).toBe('retired');
      expect(model.replacement_model).toBe(replacement);
    }

    for (const [id, effort] of [
      ['grok-4-1-fast-reasoning', 'low'],
      ['grok-4-1-fast-non-reasoning', 'none'],
    ] as const) {
      const model = catalog.get('xai', id);
      expect(model.status).toBe('retired');
      expect(model.replacement_model).toBe('grok-4.3');
      expect(model.source_url).toBe('https://docs.x.ai/developers/migration/may-15-retirement');
      expect(model.metadata).toMatchObject({
        deprecates_at: '2026-05-15T12:00:00-07:00',
        deprecation_url: 'https://docs.x.ai/developers/migration/may-15-retirement',
        retired_at: '2026-05-15',
        redirect_model: 'grok-4.3',
        redirect_reasoning_effort: effort,
      });
    }
  });
});
