import { describe, expect, it } from 'vitest';
import {
  AgentEventTypes,
  createJsonFetchFixture,
  createProviderState,
  createSSEFetchFixture,
  mediaFromBase64,
  type TurnRequest,
} from '../../src/index.js';
import { createAnthropicProvider } from '../../src/providers/anthropic/index.js';
import { createGeminiProvider } from '../../src/providers/gemini/index.js';
import { createOpenAIProvider } from '../../src/providers/openai/index.js';
import { createOpenRouterProvider } from '../../src/providers/openrouter/index.js';
import { createXAIProvider } from '../../src/providers/xai/index.js';

const turn: TurnRequest = {
  model: 'model-1',
  instructions: 'Be useful.',
  input: [{ role: 'user', content: 'Hello' }],
  max_tokens: 64,
  temperature: 0.2,
  trace_id: 'trace_1',
};

describe('provider golden mappings', () => {
  it('maps OpenAI Responses requests and preserves raw payloads', async () => {
    const fixture = createJsonFetchFixture({
      id: 'resp_1',
      model: 'gpt-4.1-mini',
      output: [
        {
          id: 'msg_1',
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'OpenAI answer' }],
        },
      ],
      usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
    });
    const provider = createOpenAIProvider({
      apiKey: 'key',
      model: 'gpt-4.1-mini',
      apiBase: 'https://openai.test/v1',
      fetchImpl: fixture.fetchImpl,
    });

    const result = await provider.turn({ ...turn, model: 'gpt-4.1-mini' });

    expect(fixture.calls[0]?.url).toBe('https://openai.test/v1/responses');
    expect(fixture.calls[0]?.body).toMatchObject({
      model: 'gpt-4.1-mini',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Hello' }],
        },
      ],
      instructions: 'Be useful.',
      max_output_tokens: 64,
      temperature: 0.2,
      stream: true,
    });
    expect(result).toMatchObject({
      output_text: 'OpenAI answer',
      tokens_in: 3,
      tokens_out: 4,
      model: 'gpt-4.1-mini',
      provider: 'openai',
    });
    expect(result.raw_response).toMatchObject({
      response: { id: 'resp_1' },
    });
  });

  it('normalizes OpenAI Responses SSE items, deltas, usage, and continuation state', async () => {
    const payloads = [
      { type: 'response.created', response: { id: 'resp_stream' } },
      {
        type: 'response.output_item.added',
        item: {
          id: 'call_item_1',
          type: 'function_call',
          status: 'in_progress',
          name: 'lookup',
          call_id: 'call_1',
          arguments: '{"id":"42"}',
        },
      },
      { type: 'response.output_text.delta', delta: 'Hello' },
      {
        type: 'response.completed',
        response: {
          id: 'resp_stream',
          output: [
            {
              id: 'call_item_1',
              type: 'function_call',
              status: 'completed',
              name: 'lookup',
              call_id: 'call_1',
              arguments: '{"id":"42"}',
            },
            {
              id: 'msg_1',
              type: 'message',
              status: 'completed',
              content: [{ type: 'output_text', text: 'Hello' }],
            },
          ],
          usage: {
            input_tokens: 3,
            output_tokens: 1,
            total_tokens: 4,
            input_tokens_details: { cached_tokens: 2 },
          },
        },
      },
    ];
    const fixture = createSSEFetchFixture(
      payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`),
    );
    const provider = createOpenAIProvider({
      apiKey: 'key',
      model: 'gpt-5',
      apiBase: 'https://openai.test/v1',
      fetchImpl: fixture.fetchImpl,
    });

    const result = await provider.turn({
      ...turn,
      model: 'gpt-5',
      tools: [{ name: 'lookup', input_schema: { type: 'object' } }],
      provider_state: createProviderState({
        provider: 'openai',
        previous_response_id: 'resp_previous',
      }),
    });

    expect(result.events?.map((event) => event.type)).toEqual([
      AgentEventTypes.MODEL_REQUEST_STARTED,
      AgentEventTypes.MODEL_ITEM_CREATED,
      AgentEventTypes.MODEL_TEXT_DELTA,
      AgentEventTypes.MODEL_COMPLETED,
    ]);
    expect(result.events?.every((event) => event.raw !== undefined)).toBe(true);
    expect(result.output_text).toBe('Hello');
    const functionCall = result.items?.find((item) => item.type === 'function_call');
    expect(functionCall?.data).toMatchObject({ name: 'lookup', call_id: 'call_1' });
    expect(result.provider_state).toMatchObject({
      provider: 'openai',
      previous_response_id: 'resp_stream',
    });
    expect(result.usage).toMatchObject({
      input_tokens: 3,
      output_tokens: 1,
      cached_input_tokens: 2,
    });
    expect(fixture.calls[0]?.body).toMatchObject({
      previous_response_id: 'resp_previous',
      tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }],
    });
  });

  it('maps Anthropic messages requests and usage', async () => {
    const fixture = createJsonFetchFixture({
      model: 'claude-sonnet-4-5',
      content: [{ type: 'text', text: 'Anthropic answer' }],
      usage: { input_tokens: 5, output_tokens: 6 },
    });
    const provider = createAnthropicProvider({
      apiKey: 'key',
      model: 'claude-sonnet-4-5',
      apiBase: 'https://anthropic.test',
      fetchImpl: fixture.fetchImpl,
    });

    const result = await provider.turn({ ...turn, model: 'claude-sonnet-4-5' });

    expect(fixture.calls[0]?.url).toBe('https://anthropic.test/v1/messages');
    expect(fixture.calls[0]?.headers['x-api-key']).toBe('key');
    expect(fixture.calls[0]?.body).toMatchObject({
      model: 'claude-sonnet-4-5',
      system: 'Be useful.',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 64,
    });
    expect(result.output_text).toBe('Anthropic answer');
    expect(result.usage).toMatchObject({ input_tokens: 5, output_tokens: 6, total_tokens: 11 });
  });

  it('normalizes Anthropic streaming blocks, tool arguments, cache usage, and native history', async () => {
    const payloads = [
      {
        type: 'message_start',
        message: {
          id: 'msg_stream',
          model: 'claude-sonnet-4-6',
          usage: {
            input_tokens: 10,
            output_tokens: 0,
            cache_read_input_tokens: 4,
            cache_creation_input_tokens: 2,
          },
        },
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: {} },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"id":"42"}' },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'text', text: '' },
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'text_delta', text: 'Anthropic stream' },
      },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', usage: { output_tokens: 3 } },
      { type: 'message_stop' },
    ];
    const fixture = createSSEFetchFixture(
      payloads.map((payload) => `event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`),
    );
    const provider = createAnthropicProvider({
      apiKey: 'key',
      model: 'claude-sonnet-4-6',
      apiBase: 'https://anthropic.test',
      fetchImpl: fixture.fetchImpl,
    });

    const result = await provider.turn({
      ...turn,
      model: 'claude-sonnet-4-6',
      tools: [{ name: 'lookup', input_schema: { type: 'object' } }],
      cache: { control: { type: 'ephemeral' } },
    });

    expect(result.output_text).toBe('Anthropic stream');
    expect(result.items?.find((item) => item.type === 'function_call')?.data).toMatchObject({
      name: 'lookup',
      call_id: 'toolu_1',
      arguments: '{"id":"42"}',
    });
    expect(result.usage).toMatchObject({
      input_tokens: 10,
      output_tokens: 3,
      cached_input_tokens: 6,
      cache_read_input_tokens: 4,
      cache_creation_input_tokens: 2,
    });
    expect(result.provider_state).toMatchObject({ provider: 'anthropic' });
    expect(result.events?.every((event) => event.raw !== undefined)).toBe(true);
    expect(fixture.calls[0]?.body).toMatchObject({
      stream: true,
      tools: [{ name: 'lookup', input_schema: { type: 'object' } }],
      system: [
        {
          type: 'text',
          text: 'Be useful.',
          cache_control: { type: 'ephemeral' },
        },
      ],
    });
  });

  it('maps Gemini generateContent requests and usage', async () => {
    const fixture = createJsonFetchFixture({
      candidates: [{ content: { parts: [{ text: 'Gemini answer' }] } }],
      usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 8, totalTokenCount: 15 },
    });
    const provider = createGeminiProvider({
      apiKey: 'key',
      model: 'gemini-2.5-flash',
      apiBase: 'https://gemini.test/v1beta',
      fetchImpl: fixture.fetchImpl,
    });

    const result = await provider.turn({ ...turn, model: 'gemini-2.5-flash' });

    expect(fixture.calls[0]?.url).toBe(
      'https://gemini.test/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse&key=key',
    );
    expect(fixture.calls[0]?.body).toMatchObject({
      contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
      systemInstruction: { parts: [{ text: 'Be useful.' }] },
      generationConfig: { maxOutputTokens: 64, temperature: 0.2 },
    });
    expect(result.output_text).toBe('Gemini answer');
    expect(result.tokens_in).toBe(7);
    expect(result.tokens_out).toBe(8);
  });

  it('normalizes Gemini SSE ordered parts, thoughts, calls, grounding, and provider state', async () => {
    const chunks = [
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                { text: 'considering', thought: true, thoughtSignature: 'sig_1' },
                {
                  functionCall: { id: 'call_g1', name: 'lookup', args: { id: '42' } },
                  thoughtSignature: 'sig_2',
                },
              ],
            },
          },
        ],
        usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 1 },
      },
      {
        candidates: [
          {
            content: { role: 'model', parts: [{ text: 'Gemini stream' }] },
            finishReason: 'STOP',
            groundingMetadata: { groundingChunks: [{ web: { uri: 'https://example.test' } }] },
          },
        ],
        usageMetadata: {
          promptTokenCount: 8,
          candidatesTokenCount: 4,
          totalTokenCount: 12,
          cachedContentTokenCount: 3,
          thoughtsTokenCount: 2,
        },
      },
    ];
    const fixture = createSSEFetchFixture(
      chunks.map((payload) => `data: ${JSON.stringify(payload)}\n\n`),
    );
    const provider = createGeminiProvider({
      apiKey: 'key',
      model: 'gemini-2.5-flash',
      apiBase: 'https://gemini.test/v1beta',
      fetchImpl: fixture.fetchImpl,
    });
    const previous = { role: 'user', parts: [{ text: 'previous' }] };

    const result = await provider.turn({
      ...turn,
      model: 'gemini-2.5-flash',
      input: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'listen' },
            { type: 'audio', media: mediaFromBase64('AQID', 'audio/wav') },
          ],
        },
      ],
      tools: [{ name: 'lookup', input_schema: { type: 'object' } }],
      hosted_tools: [{ type: 'web_search' }],
      cache: { cached_content: 'cachedContents/1' },
      provider_state: createProviderState({ provider: 'google', native_history: [previous] }),
    });

    expect(result.provider).toBe('google');
    expect(result.output_text).toBe('Gemini stream');
    expect(result.items?.find((item) => item.type === 'function_call')?.data).toMatchObject({
      name: 'lookup',
      call_id: 'call_g1',
      arguments: { id: '42' },
    });
    expect(result.provider_state).toMatchObject({
      provider: 'google',
      reasoning_state: { thought_signatures: ['sig_1', 'sig_2'] },
    });
    expect(result.usage).toMatchObject({
      input_tokens: 8,
      output_tokens: 4,
      cached_input_tokens: 3,
      reasoning_tokens: 2,
    });
    expect(result.events?.every((event) => event.raw !== undefined)).toBe(true);
    expect(fixture.calls[0]?.body).toMatchObject({
      cachedContent: 'cachedContents/1',
      contents: [
        previous,
        {
          role: 'user',
          parts: [{ text: 'listen' }, { inlineData: { mimeType: 'audio/wav', data: 'AQID' } }],
        },
      ],
      tools: [
        { functionDeclarations: [{ name: 'lookup', parameters: { type: 'object' } }] },
        { googleSearch: {} },
      ],
    });
  });

  it('reuses Responses mechanics for xAI without inheriting OpenAI identity', async () => {
    const fixture = createJsonFetchFixture({
      id: 'resp_xai',
      model: 'grok-4-fast',
      output: [
        {
          id: 'msg_xai',
          type: 'message',
          status: 'completed',
          content: [{ type: 'output_text', text: 'xAI answer' }],
        },
      ],
      usage: { input_tokens: 1, output_tokens: 2 },
    });
    const provider = createXAIProvider({
      apiKey: 'key',
      model: 'grok-4-fast',
      apiBase: 'https://xai.test/v1',
      fetchImpl: fixture.fetchImpl,
    });

    const result = await provider.turn({ ...turn, model: 'grok-4-fast' });

    expect(fixture.calls[0]?.url).toBe('https://xai.test/v1/responses');
    expect(result.provider).toBe('xai');
    expect(result.output_text).toBe('xAI answer');
  });

  it('maps OpenRouter as an aggregator provider with app headers', async () => {
    const fixture = createJsonFetchFixture({
      model: 'openai/gpt-4.1-mini',
      choices: [{ message: { content: 'OpenRouter answer' } }],
      usage: { prompt_tokens: 2, completion_tokens: 3 },
    });
    const provider = createOpenRouterProvider({
      apiKey: 'key',
      model: 'openai/gpt-4.1-mini',
      apiBase: 'https://openrouter.test/api/v1',
      appUrl: 'https://tyxter.test',
      appTitle: 'Tyxter',
      fetchImpl: fixture.fetchImpl,
    });

    const result = await provider.turn({ ...turn, model: 'openai/gpt-4.1-mini' });

    expect(fixture.calls[0]?.url).toBe('https://openrouter.test/api/v1/chat/completions');
    expect(fixture.calls[0]?.headers['HTTP-Referer']).toBe('https://tyxter.test');
    expect(fixture.calls[0]?.headers['X-Title']).toBe('Tyxter');
    expect(result.provider).toBe('openrouter');
  });
});
