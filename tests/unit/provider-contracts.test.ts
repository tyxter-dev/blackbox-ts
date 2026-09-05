import { describe, expect, it } from 'vitest';

import {
  AgentEventTypes,
  ConfigurationError,
  UnsupportedCapabilityError,
  complete,
  createAgentEvent,
  createAnthropicProvider,
  createGeminiProvider,
  createJsonFetchFixture,
  createOpenAIProvider,
  createOpenRouterProvider,
  createProviderState,
  createXAIProvider,
  modelUsage,
  structuredOutput,
  textCompletionCapabilityProfile,
  type ModelProvider,
  type OpenAIResponsesProvider,
  type TurnRequest,
} from '../../src/index.js';

const request: TurnRequest = {
  model: 'model',
  input: 'hello',
  trace_id: 'trace_contract',
};

const ADAPTIVE_CLAUDE_MODELS = [
  'claude-fable-5-1',
  'claude-fable-5',
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-opus-4-8',
] as const;

const ANTHROPIC_MESSAGE = {
  id: 'msg_adaptive',
  role: 'assistant',
  content: [{ type: 'text', text: 'ok' }],
  usage: { input_tokens: 1, output_tokens: 1 },
};

function anthropicProvider(model: string, fetchImpl: typeof fetch) {
  return createAnthropicProvider({ apiKey: 'key', model, fetchImpl });
}

describe('provider capability contract suite', () => {
  it('rejects every unsupported normalized surface before fetch dispatch', async () => {
    const openaiFetch = createJsonFetchFixture({});
    const xaiFetch = createJsonFetchFixture({});
    const anthropicFetch = createJsonFetchFixture({});
    const geminiFetch = createJsonFetchFixture({});
    const openrouterFetch = createJsonFetchFixture({});
    const cases: readonly [Promise<unknown>, { readonly calls: readonly unknown[] }][] = [
      [
        createOpenAIProvider({
          apiKey: 'key',
          model: 'model',
          fetchImpl: openaiFetch.fetchImpl,
        }).turn({ ...request, workspace: { kind: 'local' } }),
        openaiFetch,
      ],
      [
        createXAIProvider({ apiKey: 'key', model: 'model', fetchImpl: xaiFetch.fetchImpl }).turn({
          ...request,
          hosted_tools: [{ type: 'web_search' }],
        }),
        xaiFetch,
      ],
      [
        createAnthropicProvider({
          apiKey: 'key',
          model: 'claude-sonnet-4-6',
          fetchImpl: anthropicFetch.fetchImpl,
        }).turn({
          ...request,
          model: 'claude-sonnet-4-6',
          mcp_connections: [{ id: 'remote', transport: 'http' }],
        }),
        anthropicFetch,
      ],
      [
        createGeminiProvider({
          apiKey: 'key',
          model: 'gemini-2.5-flash',
          fetchImpl: geminiFetch.fetchImpl,
        }).turn({ ...request, model: 'gemini-2.5-flash', modalities: ['audio'] }),
        geminiFetch,
      ],
      [
        createOpenRouterProvider({
          apiKey: 'key',
          model: 'openai/model',
          fetchImpl: openrouterFetch.fetchImpl,
        }).turn({ ...request, model: 'openai/model', tools: [{ name: 'lookup' }] }),
        openrouterFetch,
      ],
    ];

    for (const [pending, fixture] of cases) {
      await expect(pending).rejects.toBeInstanceOf(UnsupportedCapabilityError);
      expect(fixture.calls).toHaveLength(0);
    }
  });

  it('enforces the current-model reasoning effort tables for OpenAI Responses and xAI', async () => {
    const cases: readonly {
      readonly create: (config: {
        readonly apiKey: string;
        readonly model: string;
        readonly fetchImpl: typeof fetch;
      }) => OpenAIResponsesProvider;
      readonly model: string;
      readonly good: string;
      readonly bad: string;
    }[] = [
      { create: createOpenAIProvider, model: 'gpt-6-astra', good: 'max', bad: 'none' },
      { create: createOpenAIProvider, model: 'gpt-5.6-sol', good: 'none', bad: 'minimal' },
      { create: createOpenAIProvider, model: 'gpt-5.6', good: 'max', bad: 'minimal' },
      { create: createOpenAIProvider, model: 'gpt-5.6-terra', good: 'max', bad: 'minimal' },
      { create: createOpenAIProvider, model: 'gpt-5.6-luna', good: 'max', bad: 'minimal' },
      { create: createXAIProvider, model: 'grok-4.6', good: 'xhigh', bad: 'max' },
    ];

    for (const { create, model, good, bad } of cases) {
      const accepted = createJsonFetchFixture({ id: 'resp', output: [], usage: {} });
      const provider = create({ apiKey: 'key', model, fetchImpl: accepted.fetchImpl });
      const supported = provider.capabilities(model).controls.reasoning_effort?.supported_values;
      expect(supported, model).toContain(good);
      expect(supported, model).not.toContain(bad);

      await provider.turn({ ...request, model, reasoning_effort: good });
      expect(accepted.calls[0]?.body, model).toMatchObject({ reasoning: { effort: good } });

      const rejected: readonly Partial<TurnRequest>[] = [
        { reasoning_effort: bad },
        { extra: { reasoning: { effort: bad } } },
      ];
      for (const variant of rejected) {
        const fixture = createJsonFetchFixture({});
        const guarded = create({ apiKey: 'key', model, fetchImpl: fixture.fetchImpl });
        await expect(
          guarded.turn({ ...request, model, ...variant }),
          `${model} ${JSON.stringify(variant)}`,
        ).rejects.toBeInstanceOf(UnsupportedCapabilityError);
        expect(fixture.calls, model).toHaveLength(0);
      }
    }
  });

  it('rejects GPT-6 Astra sampling and logprobs surfaces before dispatch', async () => {
    const profile = createOpenAIProvider({
      apiKey: 'key',
      model: 'gpt-6-astra',
      fetchImpl: createJsonFetchFixture({}).fetchImpl,
    }).capabilities('gpt-6-astra');
    expect(profile.controls.temperature?.status).toBe('unsupported');
    expect(profile.controls.top_p?.status).toBe('unsupported');
    expect(profile.controls.top_logprobs?.status).toBe('unsupported');
    expect(profile.controls.include?.reason).toContain('message.output_text.logprobs');

    const variants: readonly Partial<TurnRequest>[] = [
      { temperature: 1 },
      { top_p: 1 },
      { extra: { temperature: 1 } },
      { extra: { top_p: 1 } },
      { extra: { top_logprobs: 1 } },
      { include: ['reasoning.encrypted_content', 'message.output_text.logprobs'] },
      { extra: { include: ['message.output_text.logprobs'] } },
      { extra: { include: 'message.output_text.logprobs' } },
    ];

    for (const variant of variants) {
      const fixture = createJsonFetchFixture({});
      const provider = createOpenAIProvider({
        apiKey: 'key',
        model: 'gpt-6-astra',
        fetchImpl: fixture.fetchImpl,
      });
      await expect(
        provider.turn({ ...request, model: 'gpt-6-astra', ...variant }),
        JSON.stringify(variant),
      ).rejects.toBeInstanceOf(UnsupportedCapabilityError);
      expect(fixture.calls, JSON.stringify(variant)).toHaveLength(0);
    }
  });

  it('maps current-model cache ttl onto prompt_cache_options with native options winning', async () => {
    for (const model of [
      'gpt-6-astra',
      'gpt-5.6-sol',
      'gpt-5.6',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
    ]) {
      const typed = createJsonFetchFixture({ id: 'resp', output: [], usage: {} });
      const provider = createOpenAIProvider({ apiKey: 'key', model, fetchImpl: typed.fetchImpl });

      await provider.turn({
        ...request,
        model,
        cache: { ttl: '30m' },
        extra: { prompt_cache_options: { custom: true } },
      });

      expect(typed.calls[0]?.body, model).toMatchObject({
        prompt_cache_options: { ttl: '30m', custom: true },
      });
      expect(typed.calls[0]?.body, model).not.toHaveProperty('prompt_cache_retention');
      const controls = provider.capabilities(model).controls;
      expect(controls.cache_ttl?.native_name, model).toBe('prompt_cache_options.ttl');
      expect(controls.cache_ttl?.supported_values, model).toEqual(['30m']);

      const native = createJsonFetchFixture({ id: 'resp', output: [], usage: {} });
      await createOpenAIProvider({ apiKey: 'key', model, fetchImpl: native.fetchImpl }).turn({
        ...request,
        model,
        cache: { ttl: '24h' },
        extra: { prompt_cache_options: { ttl: '30m', custom: true } },
      });
      expect(native.calls[0]?.body, model).toMatchObject({
        prompt_cache_options: { ttl: '30m', custom: true },
      });

      const alias = createJsonFetchFixture({ id: 'resp', output: [], usage: {} });
      await createOpenAIProvider({ apiKey: 'key', model, fetchImpl: alias.fetchImpl }).turn({
        ...request,
        model,
        cache: { ttl: '30m', retention: '24h' },
      });
      expect(alias.calls[0]?.body, model).toMatchObject({ prompt_cache_options: { ttl: '30m' } });
    }
  });

  it('rejects unsupported current-model cache surfaces before dispatch', async () => {
    const variants: readonly Partial<TurnRequest>[] = [
      { cache: { ttl: '24h' } },
      { cache: { retention: '24h' } },
      { cache: { ttl: '24h', retention: '30m' } },
      { cache: { ttl: 1800 } },
      { extra: { prompt_cache_options: { ttl: '24h' } } },
      { extra: { prompt_cache_retention: '30m' } },
      { extra: { prompt_cache_options: 'never' } },
    ];

    for (const variant of variants) {
      const fixture = createJsonFetchFixture({});
      const provider = createOpenAIProvider({
        apiKey: 'key',
        model: 'gpt-5.6-sol',
        fetchImpl: fixture.fetchImpl,
      });
      await expect(
        provider.turn({ ...request, model: 'gpt-5.6-sol', ...variant }),
        JSON.stringify(variant),
      ).rejects.toBeInstanceOf(UnsupportedCapabilityError);
      expect(fixture.calls, JSON.stringify(variant)).toHaveLength(0);
    }
  });

  it('keeps the legacy cache retention key and effort list for older Responses models', async () => {
    const fixture = createJsonFetchFixture({ id: 'resp', output: [], usage: {} });
    const provider = createOpenAIProvider({
      apiKey: 'key',
      model: 'gpt-4.1-mini',
      fetchImpl: fixture.fetchImpl,
    });

    await provider.turn({
      ...request,
      model: 'gpt-4.1-mini',
      temperature: 0.2,
      reasoning_effort: 'high',
      cache: { key: 'cache_1', ttl: '24h' },
    });

    expect(fixture.calls[0]?.body).toMatchObject({
      temperature: 0.2,
      reasoning: { effort: 'high' },
      prompt_cache_key: 'cache_1',
      prompt_cache_retention: '24h',
    });
    expect(fixture.calls[0]?.body).not.toHaveProperty('prompt_cache_options');
    const controls = provider.capabilities('gpt-4.1-mini').controls;
    expect(controls.cache_ttl?.native_name).toBe('prompt_cache_retention');
    expect(controls.reasoning_effort?.supported_values).toEqual([
      'minimal',
      'low',
      'medium',
      'high',
    ]);

    const alias = createJsonFetchFixture({ id: 'resp', output: [], usage: {} });
    await createOpenAIProvider({
      apiKey: 'key',
      model: 'gpt-4.1-mini',
      fetchImpl: alias.fetchImpl,
    }).turn({ ...request, model: 'gpt-4.1-mini', cache: { retention: '12h' } });
    expect(alias.calls[0]?.body).toMatchObject({ prompt_cache_retention: '12h' });
  });

  it('advertises the adaptive Claude profile and separates structured output from compaction', () => {
    const provider = createAnthropicProvider({
      apiKey: 'key',
      model: 'claude-fable-5',
      fetchImpl: createJsonFetchFixture({}).fetchImpl,
    });

    for (const model of ADAPTIVE_CLAUDE_MODELS) {
      const profile = provider.capabilities(model);
      expect(profile.output.provider_native?.status, model).toBe('supported');
      expect(profile.summary.supports_structured_output, model).toBe(true);
      expect(profile.controls.compaction?.status, model).toBe('supported');
      expect(profile.controls.reasoning_effort?.supported_values, model).toEqual([
        'low',
        'medium',
        'high',
        'xhigh',
        'max',
      ]);
      expect(profile.controls.reasoning_effort?.native_name, model).toBe('output_config.effort');
      expect(profile.output.finalizer_tool?.status, model).toBe(
        model === 'claude-fable-5-1' ? 'unsupported' : 'supported',
      );
      // Forced tool choice stays advertised as supported and is rejected on the body.
      expect(profile.controls.tool_choice?.status, model).toBe('supported');
    }

    const haiku = provider.capabilities('claude-haiku-4-5-20251001');
    expect(haiku.output.provider_native?.status).toBe('supported');
    expect(haiku.controls.compaction?.status).toBe('unsupported');
    expect(provider.capabilities('Claude_Sonnet_4_6').controls.compaction?.status).toBe(
      'supported',
    );

    const unknown = provider.capabilities('claude-fable-99');
    expect(unknown.output.provider_native?.status).toBe('unsupported');
    expect(unknown.summary.supports_structured_output).toBe(false);
    expect(unknown.controls.reasoning_effort?.supported_values).toEqual(['low', 'medium', 'high']);
  });

  it('rejects native-incompatible controls for adaptive Claude models before dispatch', async () => {
    const variants: readonly [Partial<TurnRequest>, RegExp][] = [
      [{ extra: { thinking: { type: 'enabled', budget_tokens: 1024 } } }, /without a token budget/],
      [{ extra: { thinking: 'adaptive' } }, /without a token budget/],
      [{ extra: { temperature: 0.2 } }, /nondefault temperature/],
      [{ extra: { top_p: 0.9 } }, /nondefault top_p/],
      [{ extra: { top_k: 5 } }, /nondefault top_k/],
      [{ extra: { output_config: { effort: 'minimal' } } }, /'minimal' is not supported/],
      [{ extra: { output_config: 'json' } }, /output_config must be an object/],
      [{ extra: { output_config: null } }, /output_config must be an object/],
      [{ extra: { output_config: { effort: null } } }, /'null' is not supported/],
      [{ temperature: 0.5 }, /nondefault temperature/],
      [{ top_p: 0.9 }, /nondefault top_p/],
      [{ reasoning_effort: 'none' }, /'none' is not supported/],
      [
        { reasoning_effort: 'max', extra: { output_config: { effort: 'low' } } },
        /Native and typed reasoning efforts conflict/,
      ],
    ];

    for (const model of ADAPTIVE_CLAUDE_MODELS) {
      for (const [variant, reason] of variants) {
        const fixture = createJsonFetchFixture(ANTHROPIC_MESSAGE);
        const label = `${model} ${JSON.stringify(variant)}`;
        const pending = anthropicProvider(model, fixture.fetchImpl).turn({
          ...request,
          model,
          ...variant,
        });
        await expect(pending, label).rejects.toBeInstanceOf(UnsupportedCapabilityError);
        await expect(pending, label).rejects.toThrow(reason);
        expect(fixture.calls, label).toHaveLength(0);
      }
    }

    const accepted = createJsonFetchFixture(ANTHROPIC_MESSAGE);
    await anthropicProvider('claude-sonnet-5', accepted.fetchImpl).turn({
      ...request,
      model: 'claude-sonnet-5',
      temperature: 1,
      extra: { top_p: 1, output_config: { effort: 'xhigh' } },
    });
    expect(accepted.calls[0]?.body).toMatchObject({
      temperature: 1,
      top_p: 1,
      output_config: { effort: 'xhigh' },
    });
    expect(accepted.calls[0]?.body).not.toHaveProperty('thinking');
  });

  it('refuses disabled thinking only where the adaptive Claude model forbids it', async () => {
    for (const model of ADAPTIVE_CLAUDE_MODELS) {
      const fixture = createJsonFetchFixture(ANTHROPIC_MESSAGE);
      const pending = anthropicProvider(model, fixture.fetchImpl).turn({
        ...request,
        model,
        extra: { thinking: { type: 'disabled' } },
      });
      if (model.startsWith('claude-fable')) {
        await expect(pending, model).rejects.toBeInstanceOf(UnsupportedCapabilityError);
        expect(fixture.calls, model).toHaveLength(0);
      } else {
        await pending;
        expect(fixture.calls[0]?.body, model).toMatchObject({ thinking: { type: 'disabled' } });
      }
    }

    for (const effort of ['xhigh', 'max']) {
      const fixture = createJsonFetchFixture(ANTHROPIC_MESSAGE);
      await expect(
        anthropicProvider('claude-opus-5', fixture.fetchImpl).turn({
          ...request,
          model: 'claude-opus-5',
          reasoning_effort: effort,
          extra: { thinking: { type: 'disabled' } },
        }),
        effort,
      ).rejects.toBeInstanceOf(UnsupportedCapabilityError);
      expect(fixture.calls, effort).toHaveLength(0);
    }

    const allowed = createJsonFetchFixture(ANTHROPIC_MESSAGE);
    await anthropicProvider('claude-opus-5', allowed.fetchImpl).turn({
      ...request,
      model: 'claude-opus-5',
      reasoning_effort: 'high',
      extra: { thinking: { type: 'disabled' } },
    });
    expect(allowed.calls[0]?.body).toMatchObject({
      thinking: { type: 'disabled' },
      output_config: { effort: 'high' },
    });
  });

  it('refuses forced tool choice and finalizer output on Claude Fable 5.1', async () => {
    const variants: readonly Partial<TurnRequest>[] = [
      { tool_choice: 'required' },
      { tool_choice: 'answer' },
      { extra: { tool_choice: { type: 'tool', name: 'answer' } } },
      { output: structuredOutput({ type: 'object' }, { strategy: 'finalizer_tool' }) },
    ];

    for (const variant of variants) {
      const fixture = createJsonFetchFixture(ANTHROPIC_MESSAGE);
      await expect(
        anthropicProvider('claude-fable-5-1', fixture.fetchImpl).turn({
          ...request,
          model: 'claude-fable-5-1',
          ...variant,
        }),
        JSON.stringify(variant),
      ).rejects.toBeInstanceOf(UnsupportedCapabilityError);
      expect(fixture.calls, JSON.stringify(variant)).toHaveLength(0);
    }

    const auto = createJsonFetchFixture(ANTHROPIC_MESSAGE);
    await anthropicProvider('claude-fable-5-1', auto.fetchImpl).turn({
      ...request,
      model: 'claude-fable-5-1',
      tool_choice: 'auto',
    });
    expect(auto.calls[0]?.body).toMatchObject({ tool_choice: { type: 'auto' } });

    const sibling = createJsonFetchFixture(ANTHROPIC_MESSAGE);
    await anthropicProvider('claude-fable-5', sibling.fetchImpl).turn({
      ...request,
      model: 'claude-fable-5',
      tool_choice: 'required',
    });
    expect(sibling.calls[0]?.body).toMatchObject({ tool_choice: { type: 'any' } });
  });

  it('binds Claude Fable 5.1 replay to the recorded prefix', async () => {
    const native = [
      { type: 'thinking', thinking: '', signature: 'opaque' },
      { type: 'text', text: 'done' },
    ];
    const fixture = createJsonFetchFixture({ ...ANTHROPIC_MESSAGE, content: native });
    const provider = anthropicProvider('claude-fable-5-1', fixture.fetchImpl);
    const first = await provider.turn({
      ...request,
      model: 'claude-fable-5-1',
      instructions: 'stable',
    });
    const state = first.provider_state;

    expect(state?.native_history).toEqual([{ role: 'assistant', content: native }]);
    expect(state?.tool_state.fable_5_1_prefix).toMatchObject({
      model: 'claude-fable-5-1',
      message_count: 1,
    });

    // A serialization round trip must not invalidate the recorded digest.
    const restored = JSON.parse(JSON.stringify(state)) as NonNullable<typeof state>;
    await provider.turn({
      ...request,
      model: 'claude-fable-5-1',
      instructions: 'stable',
      input: 'next',
      provider_state: restored,
    });
    expect(fixture.calls).toHaveLength(2);
    expect(fixture.calls[1]?.body).toMatchObject({
      messages: [
        { role: 'assistant', content: native },
        { role: 'user', content: 'next' },
      ],
    });

    const changedPrefix = /unchanged system, tools, and prior messages/;
    const variants: readonly [string, Partial<TurnRequest>, RegExp][] = [
      ['changed system', { instructions: 'changed' }, changedPrefix],
      [
        'changed tools',
        { tools: [{ name: 'new', input_schema: { type: 'object' } }] },
        changedPrefix,
      ],
      [
        'mutated history',
        {
          provider_state: createProviderState({
            ...restored,
            native_history: [{ role: 'assistant', content: 'changed' }],
          }),
        },
        changedPrefix,
      ],
      [
        'replayed to another model',
        { model: 'claude-opus-4-6' },
        /cannot be replayed to another model/,
      ],
      [
        'cleared provenance',
        { provider_state: createProviderState({ ...restored, tool_state: {} }) },
        /lacks Fable 5.1 prefix provenance/,
      ],
    ];

    for (const [label, variant, reason] of variants) {
      const guarded = createJsonFetchFixture({ ...ANTHROPIC_MESSAGE, content: native });
      const model = variant.model ?? 'claude-fable-5-1';
      const pending = anthropicProvider(model, guarded.fetchImpl).turn({
        ...request,
        model,
        instructions: 'stable',
        input: 'next',
        provider_state: restored,
        ...variant,
      });
      await expect(pending, label).rejects.toBeInstanceOf(UnsupportedCapabilityError);
      await expect(pending, label).rejects.toThrow(reason);
      expect(guarded.calls, label).toHaveLength(0);
    }
  });

  it('digests the Fable 5.1 prefix after cache mapping and reports non-JSON prefixes', async () => {
    const native = [{ type: 'thinking', thinking: '', signature: 'opaque' }];
    const cache = { control: { type: 'ephemeral' } };
    const fixture = createJsonFetchFixture({ ...ANTHROPIC_MESSAGE, content: native });
    const provider = anthropicProvider('claude-fable-5-1', fixture.fetchImpl);
    const first = await provider.turn({
      ...request,
      model: 'claude-fable-5-1',
      instructions: 'stable',
      cache,
    });
    const state = first.provider_state;

    await provider.turn({
      ...request,
      model: 'claude-fable-5-1',
      instructions: 'stable',
      input: 'next',
      cache,
      provider_state: state,
    });
    expect(fixture.calls).toHaveLength(2);
    expect(fixture.calls[1]?.body).toMatchObject({
      system: [{ type: 'text', text: 'stable', cache_control: { type: 'ephemeral' } }],
    });

    // Dropping the cache breakpoint changes the dispatched system prefix.
    const toggled = createJsonFetchFixture({ ...ANTHROPIC_MESSAGE, content: native });
    await expect(
      anthropicProvider('claude-fable-5-1', toggled.fetchImpl).turn({
        ...request,
        model: 'claude-fable-5-1',
        instructions: 'stable',
        input: 'next',
        provider_state: state,
      }),
    ).rejects.toThrow(/unchanged system, tools, and prior messages/);
    expect(toggled.calls).toHaveLength(0);

    const unserializable = createJsonFetchFixture({ ...ANTHROPIC_MESSAGE, content: native });
    await expect(
      anthropicProvider('claude-fable-5-1', unserializable.fetchImpl).turn({
        ...request,
        model: 'claude-fable-5-1',
        instructions: 'stable',
        input: 'next',
        cache,
        provider_state: state,
        extra: { tools: [{ name: 'lookup', budget: 1n }] },
      }),
    ).rejects.toThrow(/JSON-native prefix data/);
    expect(unserializable.calls).toHaveLength(0);

    // A Date has no plain-object entries: digesting it as '{}' would make
    // different tool payloads share one digest, so it is refused instead.
    const dated = createJsonFetchFixture({ ...ANTHROPIC_MESSAGE, content: native });
    await expect(
      anthropicProvider('claude-fable-5-1', dated.fetchImpl).turn({
        ...request,
        model: 'claude-fable-5-1',
        instructions: 'stable',
        input: 'next',
        cache,
        provider_state: state,
        extra: { tools: [{ name: 'lookup', since: new Date(0) }] },
      }),
    ).rejects.toThrow(/JSON-native prefix data/);
    expect(dated.calls).toHaveLength(0);
  });

  it('refuses WebFetch payloads that bypass the hosted-tool gate on Claude Opus 5', async () => {
    const bypasses: readonly Partial<TurnRequest>[] = [
      { hosted_tools: [{ type: 'raw', config: { type: 'web_fetch_20260209' } }] },
      { extra: { tools: [{ type: 'web_fetch_20260209', name: 'web_fetch' }] } },
    ];

    for (const variant of bypasses) {
      const fixture = createJsonFetchFixture(ANTHROPIC_MESSAGE);
      const pending = anthropicProvider('claude-opus-5', fixture.fetchImpl).turn({
        ...request,
        model: 'claude-opus-5',
        ...variant,
      });
      await expect(pending, JSON.stringify(variant)).rejects.toBeInstanceOf(
        UnsupportedCapabilityError,
      );
      await expect(pending, JSON.stringify(variant)).rejects.toThrow(/does not support WebFetch/);
      expect(fixture.calls, JSON.stringify(variant)).toHaveLength(0);
    }

    // Only Opus 5 refuses it: the same payload still dispatches elsewhere.
    const allowed = createJsonFetchFixture(ANTHROPIC_MESSAGE);
    await anthropicProvider('claude-sonnet-5', allowed.fetchImpl).turn({
      ...request,
      model: 'claude-sonnet-5',
      hosted_tools: [{ type: 'raw', config: { type: 'web_fetch_20260209' } }],
    });
    expect(allowed.calls[0]?.body).toMatchObject({ tools: [{ type: 'web_fetch_20260209' }] });
  });

  it('leaves replay untouched for other Claude models and refuses native message overrides', async () => {
    const native = [{ type: 'thinking', thinking: '', signature: 'opaque' }];
    const state = createProviderState({
      provider: 'anthropic',
      model: 'claude-opus-4-6',
      native_history: [{ role: 'assistant', content: native }],
    });

    // Imported thinking without provenance only concerns Fable 5.1.
    const fixture = createJsonFetchFixture(ANTHROPIC_MESSAGE);
    await anthropicProvider('claude-opus-4-6', fixture.fetchImpl).turn({
      ...request,
      model: 'claude-opus-4-6',
      input: 'next',
      provider_state: state,
    });
    expect(fixture.calls[0]?.body).toMatchObject({
      messages: [
        { role: 'assistant', content: native },
        { role: 'user', content: 'next' },
      ],
    });

    // Provider state comes back as a plain object: partial state must dispatch,
    // not crash, on models the replay guard does not cover.
    const partials = [
      { provider: 'anthropic', native_history: [{ role: 'assistant', content: native }] },
      { provider: 'anthropic', tool_state: {} },
    ];
    for (const partial of partials) {
      const loose = createJsonFetchFixture(ANTHROPIC_MESSAGE);
      await anthropicProvider('claude-sonnet-4-6', loose.fetchImpl).turn({
        ...request,
        model: 'claude-sonnet-4-6',
        input: 'next',
        provider_state: partial as unknown as TurnRequest['provider_state'],
      });
      expect(loose.calls, JSON.stringify(partial)).toHaveLength(1);
      expect(loose.calls[0]?.body, JSON.stringify(partial)).toMatchObject({
        messages: [
          ...('native_history' in partial ? [{ role: 'assistant', content: native }] : []),
          { role: 'user', content: 'next' },
        ],
      });
    }

    // Fable 5.1 reads native_history for imported thinking; absent is empty.
    const fable = createJsonFetchFixture(ANTHROPIC_MESSAGE);
    await anthropicProvider('claude-fable-5-1', fable.fetchImpl).turn({
      ...request,
      model: 'claude-fable-5-1',
      input: 'next',
      provider_state: {
        provider: 'anthropic',
        tool_state: {},
      } as unknown as TurnRequest['provider_state'],
    });
    expect(fable.calls).toHaveLength(1);

    // The parent's raw `messages` override has no TypeScript analogue: provider
    // extra always collides with the normalized field.
    const collision = createJsonFetchFixture(ANTHROPIC_MESSAGE);
    await expect(
      anthropicProvider('claude-opus-4-6', collision.fetchImpl).turn({
        ...request,
        model: 'claude-opus-4-6',
        extra: { messages: [{ role: 'user', content: 'native' }] },
      }),
    ).rejects.toBeInstanceOf(ConfigurationError);
    expect(collision.calls).toHaveLength(0);
  });

  it('applies explicit extra collision policy and forwards non-colliding raw fields', async () => {
    const collisionFetch = createJsonFetchFixture({});
    const collision = createOpenAIProvider({
      apiKey: 'key',
      model: 'gpt-5',
      fetchImpl: collisionFetch.fetchImpl,
    });
    await expect(
      collision.turn({ ...request, model: 'gpt-5', extra: { model: 'override' } }),
    ).rejects.toBeInstanceOf(ConfigurationError);
    expect(collisionFetch.calls).toHaveLength(0);

    const fixture = createJsonFetchFixture({ id: 'resp', output: [], usage: {} });
    const provider = createOpenAIProvider({
      apiKey: 'key',
      model: 'gpt-5',
      fetchImpl: fixture.fetchImpl,
    });
    await provider.turn({ ...request, model: 'gpt-5', extra: { safety_identifier: 'user_1' } });
    expect(fixture.calls[0]?.body).toMatchObject({ safety_identifier: 'user_1' });
  });

  it('collects completion compatibility from a stream-only canonical provider', async () => {
    const provider: ModelProvider = {
      id: 'stream-only',
      defaultModel: 'model',
      capabilities: (model) => textCompletionCapabilityProfile('stream-only', model),
      async *streamTurn(turn) {
        yield createAgentEvent({
          type: AgentEventTypes.MODEL_TEXT_DELTA,
          provider: 'stream-only',
          model: turn.model,
          data: { delta: 'streamed' },
        });
        yield createAgentEvent({
          type: AgentEventTypes.MODEL_COMPLETED,
          provider: 'stream-only',
          model: turn.model,
          data: {
            output_text: 'streamed',
            usage: modelUsage({ input_tokens: 1, output_tokens: 2 }),
          },
        });
      },
    };

    await expect(
      complete(provider, {
        system: 'help',
        messages: [{ role: 'user', content: 'hello' }],
        trace_id: 'trace_stream_only',
      }),
    ).resolves.toMatchObject({ content: 'streamed', tokens_in: 1, tokens_out: 2 });
  });
});
