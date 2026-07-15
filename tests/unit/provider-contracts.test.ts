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
