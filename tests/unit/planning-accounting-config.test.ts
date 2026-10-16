import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  AgentEventTypes,
  AgentRuntime,
  BUNDLED_PRICING,
  PricingCatalog,
  type PricingRates,
  InMemoryProviderCacheStore,
  ProviderCacheRuntime,
  ProviderRegistry,
  RuntimeConfig,
  ScriptedModelProvider,
  cacheUsageFromUsage,
  getWorkflowProfile,
  modelUsage,
  usageFromAnthropic,
  usageFromOpenAI,
  workflowProfileDocs,
  workflowProfiles,
} from '../../src/index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('planning, accounting, cache, and config', () => {
  it('keeps prompt dry-run instructions identical to the provider request', async () => {
    const provider = new ScriptedModelProvider([{ output_text: 'done' }], { id: 'script' });
    const registry = new ProviderRegistry();
    registry.registerModelProvider(provider);
    const runtime = new AgentRuntime({ registry });
    const request = {
      model: 'script:model',
      input: 'go',
      instructions: 'Base',
      prompt_fragments: [
        { id: 'later', content: 'Second', priority: 1 },
        { id: 'first', content: 'First', priority: 2, cache_section: 'stable' },
      ],
      trace_id: 'trace_prompt',
    } as const;
    const dryRun = runtime.prompts.dryRun(request);
    const result = await runtime.run(request);

    expect(provider.turns[0]?.instructions).toBe(dryRun.prompt.instructions);
    expect(dryRun.prompt.instructions).toBe('Base\n\nFirst\n\nSecond');
    expect(result.events.some((event) => event.type === AgentEventTypes.PROMPT_PLAN_CREATED)).toBe(
      true,
    );
  });

  it('prices detailed cache usage with provenance and billable policy', () => {
    const estimate = BUNDLED_PRICING.estimate(
      'openai',
      'gpt-5.4',
      modelUsage({
        input_tokens: 1_000_000,
        output_tokens: 100_000,
        cache_read_input_tokens: 200_000,
      }),
      { markup_bps: 1000, minimum: 0.01, rounding_increment: 0.001 },
    );

    expect(estimate.provider_cost).toBeCloseTo(3.55);
    expect(estimate.user_billable).toBeCloseTo(3.906);
    expect(estimate).toMatchObject({ source: 'blackbox-bundled', version: '2026-09-05' });
  });

  it.each([
    { combined: 200, read: 0, creation: 0, inputCost: 0.008, readCost: 0.0004, creationCost: 0 },
    {
      combined: 500,
      read: 100,
      creation: 200,
      inputCost: 0.005,
      readCost: 0.0006,
      creationCost: 0.0008,
    },
    {
      combined: 300,
      read: 100,
      creation: 200,
      inputCost: 0.007,
      readCost: 0.0002,
      creationCost: 0.0008,
    },
    {
      combined: 50,
      read: 100,
      creation: 200,
      inputCost: 0.0095,
      readCost: 0.0002,
      creationCost: 0.0008,
    },
    { combined: 1200, read: 0, creation: 0, inputCost: 0, readCost: 0.0024, creationCost: 0 },
  ])(
    'prices combined $combined, read $read and creation $creation counters independently',
    (row) => {
      const catalog = customPricing({
        input_per_million: 10,
        output_per_million: 20,
        cache_read_per_million: 2,
        cache_creation_per_million: 4,
      });
      const estimate = catalog.estimate(
        'custom',
        'model',
        modelUsage({
          input_tokens: 1000,
          cached_input_tokens: row.combined,
          cache_read_input_tokens: row.read,
          cache_creation_input_tokens: row.creation,
        }),
      );
      expect(estimate.components.input).toBeCloseTo(row.inputCost, 10);
      expect(estimate.components.cache_read).toBeCloseTo(row.readCost, 10);
      expect(estimate.components.cache_creation).toBeCloseTo(row.creationCost, 10);
      expect(estimate.provider_cost).toBeCloseTo(
        row.inputCost + row.readCost + row.creationCost,
        10,
      );
    },
  );

  it('keeps cached/read/creation/reasoning rates and provenance independent', () => {
    const rates = {
      input_per_million: 10,
      output_per_million: 20,
      cached_input_per_million: 3,
      cache_read_per_million: 2,
      cache_creation_per_million: 4,
      reasoning_output_per_million: 5,
    };
    const catalog = customPricing(rates);
    const estimate = catalog.estimate(
      'custom',
      'model',
      modelUsage({
        input_tokens: 1000,
        output_tokens: 100,
        cached_input_tokens: 500,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 200,
        reasoning_tokens: 40,
      }),
    );
    expect(catalog.get('custom', 'model')?.rates).toEqual(rates);
    const serialized = JSON.parse(JSON.stringify(catalog.list())) as readonly unknown[];
    expect(serialized[0]).toMatchObject({ rates, source_url: 'https://example.test/pricing' });
    expect(estimate.components).toEqual({
      input: 0.005,
      output: 0.002,
      cache_read: 0.0006,
      cache_creation: 0.0008,
      reasoning_output: 0.0002,
    });
    expect(estimate.provider_cost).toBeCloseTo(0.0086, 10);
    expect(estimate.source_url).toBe('https://example.test/pricing');
  });

  it.each([
    { rates: {}, read: 0.002, creation: 0.001 },
    { rates: { cached_input_per_million: 3 }, read: 0.0006, creation: 0.0003 },
    {
      rates: {
        cached_input_per_million: 3,
        cache_read_per_million: 0,
        cache_creation_per_million: 0,
      },
      read: 0,
      creation: 0,
    },
  ])(
    'uses optional cache rate fallbacks without adding an implicit reasoning charge ($rates)',
    ({ rates, read, creation }) => {
      const catalog = customPricing({ input_per_million: 10, output_per_million: 20, ...rates });
      const estimate = catalog.estimate(
        'custom',
        'model',
        modelUsage({
          input_tokens: 1000,
          output_tokens: 100,
          cache_read_input_tokens: 200,
          cache_creation_input_tokens: 100,
          reasoning_tokens: 40,
        }),
      );
      expect(estimate.components.cache_read).toBeCloseTo(read, 10);
      expect(estimate.components.cache_creation).toBeCloseTo(creation, 10);
      expect(estimate.components.output).toBe(0.002);
      expect(estimate.components).not.toHaveProperty('reasoning_output');
    },
  );

  it('resolves pricing aliases one hop with exact-row precedence and no extra rows', () => {
    const catalog = customPricing({ input_per_million: 10, output_per_million: 20 });
    catalog.registerModelAlias('custom', 'alias', 'model');
    catalog.registerModelAlias('custom', 'chain', 'alias');
    catalog.registerModelAlias('other', 'alias', 'model');
    expect(catalog.get('custom', 'alias')).toBe(catalog.get('custom', 'model'));
    expect(
      catalog.estimate('custom', 'alias', modelUsage({ input_tokens: 1000 })).provider_cost,
    ).toBe(0.01);
    expect(catalog.get('custom', 'chain')).toBeUndefined();
    expect(catalog.get('other', 'alias')).toBeUndefined();
    expect(catalog.list()).toHaveLength(1);
    const exact = {
      ...catalog.get('custom', 'model')!,
      model: 'alias',
      rates: { input_per_million: 7, output_per_million: 9 },
    };
    catalog.set(exact);
    expect(catalog.get('custom', 'alias')).toBe(exact);
    expect(catalog.list()).toHaveLength(2);
    expect(BUNDLED_PRICING.get('openai', 'gpt-5.6')).toBe(
      BUNDLED_PRICING.get('openai', 'gpt-5.6-sol'),
    );
    expect(BUNDLED_PRICING.get('openai', 'gpt-5.4-mini-2026-03-17')).toBe(
      BUNDLED_PRICING.get('openai', 'gpt-5.4-mini'),
    );
    expect(BUNDLED_PRICING.get('xai', 'grok-4.20-non-reasoning')).toBeUndefined();
    expect(() =>
      BUNDLED_PRICING.estimate('xai', 'grok-4.20-non-reasoning', modelUsage()),
    ).toThrowError(expect.objectContaining({ code: 'pricing_not_found' }));
    expect(BUNDLED_PRICING.list()).toHaveLength(36);
  });

  it('ships the refreshed standard rates, cache semantics, and per-row provenance', () => {
    for (const [provider, model, input, output] of [
      ['openai', 'gpt-6-astra', 10, 50],
      ['openai', 'gpt-5.6-sol', 4, 20],
      ['openai', 'gpt-5.6-terra', 2, 12],
      ['openai', 'gpt-5.6-luna', 0.2, 1.2],
      ['anthropic', 'claude-fable-5-1', 10, 50],
      ['anthropic', 'claude-fable-5', 10, 50],
      ['anthropic', 'claude-opus-5', 5, 25],
      ['anthropic', 'claude-sonnet-5', 2, 10],
      ['anthropic', 'claude-opus-4-8', 5, 25],
      ['xai', 'grok-4.6', 2, 6],
      ['xai', 'grok-4.3', 1.25, 2.5],
      ['xai', 'grok-4-1-fast-reasoning', 1.25, 2.5],
      ['xai', 'grok-4-1-fast-non-reasoning', 1.25, 2.5],
    ] as const) {
      const entry = BUNDLED_PRICING.get(provider, model);
      expect(entry?.rates.input_per_million).toBe(input);
      expect(entry?.rates.output_per_million).toBe(output);
      expect(entry?.effective_at).toBe('2026-09-05T00:00:00.000Z');
    }

    const fable = BUNDLED_PRICING.get('anthropic', 'claude-fable-5-1');
    expect(fable?.rates.cache_read_per_million).toBe(0.25);
    expect(fable?.rates.cache_creation_per_million).toBe(12.5);
    expect(
      BUNDLED_PRICING.estimate(
        'anthropic',
        'claude-fable-5-1',
        modelUsage({ input_tokens: 1_000_000, cache_read_input_tokens: 1_000_000 }),
      ).provider_cost,
    ).toBeCloseTo(0.25, 9);
    expect(BUNDLED_PRICING.get('anthropic', 'claude-fable-5')?.rates.cache_read_per_million).toBe(
      1,
    );
    expect(BUNDLED_PRICING.get('xai', 'grok-4.6')?.rates.cache_read_per_million).toBe(0.5);
    // xAI publishes no cache-write rate, so cache creation bills at the input rate.
    expect(BUNDLED_PRICING.get('xai', 'grok-4.6')?.rates.cache_creation_per_million).toBe(2);
    expect(BUNDLED_PRICING.get('google', 'gemini-2.5-flash')?.effective_at).toBe(
      '2026-05-06T00:00:00.000Z',
    );
  });

  it('charges inclusive Anthropic input, cache reads, and cache writes exactly once each', () => {
    const usage = usageFromAnthropic({
      input_tokens: 1000,
      output_tokens: 100,
      cache_read_input_tokens: 200,
      cache_creation_input_tokens: 300,
    });

    const estimate = BUNDLED_PRICING.estimate('anthropic', 'claude-sonnet-4-5', usage);

    // Normalized input is inclusive (1500), so ordinary input bills the 1000
    // uncached tokens while reads and writes bill once at their own rates.
    expect(usage.input_tokens).toBe(1500);
    expect(Object.keys(estimate.components).sort()).toEqual([
      'cache_creation',
      'cache_read',
      'input',
      'output',
    ]);
    expect(estimate.components.input).toBeCloseTo(0.003, 9);
    expect(estimate.components.cache_read).toBeCloseTo(0.00006, 9);
    expect(estimate.components.cache_creation).toBeCloseTo(0.001125, 9);
    expect(estimate.components.output).toBeCloseTo(0.0015, 9);
    expect(estimate.provider_cost).toBeCloseTo(0.005685, 9);
  });

  it('counts only cache reads as hits across native provider usage', () => {
    for (const read of [200, 0]) {
      expect(
        cacheUsageFromUsage({
          provider: 'openai',
          model: 'gpt-5.4',
          usage: usageFromOpenAI({
            input_tokens: 1000,
            output_tokens: 100,
            input_tokens_details: { cached_tokens: read, cache_write_tokens: 300 },
          }),
        }),
      ).toMatchObject({
        input_tokens: 1000,
        cached_input_tokens: read + 300,
        cache_creation_input_tokens: 300,
        hit: read > 0,
        hit_ratio: read / 1000,
      });

      const inclusiveInput = 1000 + read + 300;
      expect(
        cacheUsageFromUsage({
          provider: 'anthropic',
          model: 'claude-sonnet-4-5',
          usage: usageFromAnthropic({
            input_tokens: 1000,
            output_tokens: 100,
            cache_read_input_tokens: read,
            cache_creation_input_tokens: 300,
          }),
        }),
      ).toMatchObject({
        input_tokens: inclusiveInput,
        cached_input_tokens: read + 300,
        cache_creation_input_tokens: 300,
        hit: read > 0,
        hit_ratio: read / inclusiveInput,
      });
    }
  });

  it('excludes cache writes from the hit ratio and keeps the legacy combined fallback', () => {
    const writeOnly = cacheUsageFromUsage({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      usage: modelUsage({ input_tokens: 1300, cache_creation_input_tokens: 300 }),
    });

    // Before split counters governed the ratio this reported 300/1300; a write
    // alone is never a hit.
    expect(writeOnly).toMatchObject({ hit: false, hit_ratio: 0 });
    expect(writeOnly?.hit_ratio).not.toBe(300 / 1300);

    // Usage that reports no split counters still divides the combined counter,
    // and a non-positive input leaves the ratio unreported instead of dividing.
    for (const inputTokens of [1000, 0, -1]) {
      const legacy = cacheUsageFromUsage({
        provider: 'scripted',
        model: 'legacy',
        usage: modelUsage({ input_tokens: inputTokens, cached_input_tokens: 200 }),
      });
      expect(legacy).toMatchObject({
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        hit: true,
      });
      expect(legacy?.hit_ratio).toBe(inputTokens > 0 ? 0.2 : undefined);
    }
  });

  it('reports cache usage only when caching was requested or observed', () => {
    expect(
      cacheUsageFromUsage({
        provider: 'openai',
        model: 'gpt-5.4',
        usage: modelUsage({ input_tokens: 10, output_tokens: 2 }),
      }),
    ).toBeUndefined();

    expect(
      cacheUsageFromUsage({
        provider: 'openai',
        model: 'gpt-5.4',
        usage: modelUsage({ input_tokens: 10, output_tokens: 2 }),
        requested: true,
        key: 'stable-prefix',
        ttl: '5m',
      }),
    ).toMatchObject({
      requested: true,
      hit: false,
      hit_ratio: 0,
      key: 'stable-prefix',
      ttl: '5m',
    });
  });

  it('tracks cache lifecycle metrics', async () => {
    const cache = new ProviderCacheRuntime(new InMemoryProviderCacheStore());
    await cache.get('missing');
    await cache.set('key', 'openai', { response: 1 }, { cached_tokens: 42 });
    await cache.get('key');
    await cache.invalidate('key');
    expect(cache.stats()).toEqual({
      hits: 1,
      misses: 1,
      writes: 1,
      invalidations: 1,
      cached_tokens: 42,
    });
  });

  it('matches the parent workflow profile catalog, documentation, and validation', () => {
    expect(workflowProfiles().map((profile) => profile.name)).toEqual([
      'fast_text',
      'structured_extraction',
      'tool_agent',
      'retrieval_agent',
      'coding_agent',
      'cloud_agent_session',
      'realtime_voice',
      'eval_run',
      'cost_sensitive',
      'high_reliability',
    ]);
    expect(workflowProfileDocs().coding_agent).toMatchObject({
      required: [{ any_of: ['workspace'] }],
      required_capabilities: ['function_tools'],
    });
    expect(getWorkflowProfile('fast_text').defaultsFor('runtime')).toMatchObject({
      temperature: 0.2,
      max_output_tokens: 512,
      max_iterations: 1,
    });
    expect(() => RuntimeConfig.profile('realtime_voice').toValues({ surface: 'runtime' })).toThrow(
      /cannot be used/,
    );
    expect(() => RuntimeConfig.profile('coding_agent').toValues({ surface: 'runtime' })).toThrow(
      /workspace/,
    );
  });

  it('parses parent-compatible environment controls and normalizes provider-qualified models', () => {
    const config = RuntimeConfig.fromEnv({
      env: {
        AGENT_RUNTIME_PROFILE: 'cost_sensitive',
        AGENT_RUNTIME_MODEL: 'openai:gpt-5.5',
        AGENT_RUNTIME_TEMPERATURE: '0.1',
        AGENT_RUNTIME_PARALLEL_TOOL_CALLS: 'false',
        AGENT_RUNTIME_CACHE_STRATEGY: 'ephemeral',
        AGENT_RUNTIME_TOOL_SEARCH_MAX_RESULTS: '3',
        AGENT_RUNTIME_CONTEXT_FLAGS: 'eval,nightly',
      },
    });

    expect(config.toValues({ surface: 'runtime' })).toMatchObject({
      provider: 'openai:gpt-5.5',
      temperature: 0.1,
      parallel_tool_calls: false,
      cache: { strategy: 'ephemeral' },
      tool_search: { max_results: 3 },
      context_flags: ['eval', 'nightly'],
    });
    expect(() =>
      RuntimeConfig.profile('fast_text')
        .withOverrides({ provider: 'anthropic', model: 'openai:gpt-5.5' })
        .toValues({ surface: 'model' }),
    ).toThrow(/does not match/);
  });

  it('applies profile < env < file < mapping < explicit request precedence and freezes config', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'blackbox-config-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'config.json');
    await writeFile(
      path,
      JSON.stringify({ model: 'file:model', max_iterations: 20, tool_timeout_ms: 5000 }),
      'utf8',
    );
    const config = await RuntimeConfig.load({
      profile: 'fast_text',
      env: { AGENT_RUNTIME_MODEL: 'env:model', AGENT_RUNTIME_MAX_ITERATIONS: '10' },
      file: path,
      mapping: { model: 'mapping:model', max_iterations: 30 },
    });
    const resolved = config.resolveRun({
      input: 'go',
      model: 'explicit:model',
      max_iterations: 40,
    });

    expect(config.overrides).toMatchObject({
      model: 'mapping:model',
      max_iterations: 30,
      tool_timeout_ms: 5000,
    });
    expect(resolved).toMatchObject({ model: 'explicit:model', max_iterations: 40 });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.overrides)).toBe(true);
  });

  it('loads the dependency-free TOML subset used by runtime configuration', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'blackbox-config-toml-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'runtime.toml');
    await writeFile(
      path,
      'profile = "fast_text"\nmodel = "openai:gpt-5.5"\nmax_output_tokens = 300\n\n[cache]\nstrategy = "ephemeral"\n',
      'utf8',
    );

    expect(
      await RuntimeConfig.fromFile(path).then((config) => config.toValues({ surface: 'model' })),
    ).toMatchObject({
      provider: 'openai:gpt-5.5',
      max_output_tokens: 300,
      cache: { strategy: 'ephemeral' },
    });
  });

  it('expands configuration into model and agent runtime calls before dispatch', async () => {
    const provider = new ScriptedModelProvider(
      [
        { output_text: 'model configured' },
        { output_text: 'agent configured' },
        { output_text: 'model override' },
      ],
      { id: 'script' },
    );
    const registry = new ProviderRegistry();
    registry.registerModelProvider(provider);
    const runtime = new AgentRuntime({ registry });
    const config = RuntimeConfig.profile('fast_text').withOverrides({
      provider: 'script:model',
      max_output_tokens: 256,
    });

    const modelResult = await runtime.models.run({ input: 'model', config });
    const agentResult = await runtime.run({ input: 'agent', config, max_output_tokens: 128 });
    const overridden = await runtime.models.run({ input: 'override', config, model: 'other' });

    expect(modelResult.output_text).toBe('model configured');
    expect(agentResult.text).toBe('agent configured');
    expect(overridden.output_text).toBe('model override');
    expect(provider.turns[0]).toMatchObject({ temperature: 0.2, max_output_tokens: 256 });
    expect(provider.turns[1]).toMatchObject({ temperature: 0.2, max_output_tokens: 128 });
    expect(provider.turns[2]?.model).toBe('other');
  });

  it('rejects a workflow profile on the wrong runtime surface before provider dispatch', async () => {
    const provider = new ScriptedModelProvider([{ output_text: 'unreachable' }], { id: 'script' });
    const registry = new ProviderRegistry();
    registry.registerModelProvider(provider);
    const runtime = new AgentRuntime({ registry });
    const config = RuntimeConfig.profile('realtime_voice').withOverrides({
      provider: 'script:model',
    });

    await expect(runtime.run({ input: 'no dispatch', config })).rejects.toThrow(/cannot be used/);
    expect(provider.turns).toHaveLength(0);
  });
});

function customPricing(rates: PricingRates): PricingCatalog {
  return new PricingCatalog([
    {
      provider: 'custom',
      model: 'model',
      currency: 'USD',
      rates,
      source: 'test',
      source_url: 'https://example.test/pricing',
      version: '1',
      effective_at: '2026-09-08T00:00:00.000Z',
      metadata: {},
    },
  ]);
}
