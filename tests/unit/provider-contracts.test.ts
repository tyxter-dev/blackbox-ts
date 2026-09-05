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
  createXAIProvider,
  modelUsage,
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
