import { describe, expect, it } from 'vitest';
import { createJsonFetchFixture, type TurnRequest } from '../../src/index.js';
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
  it('maps OpenAI chat completion requests and preserves raw payloads', async () => {
    const fixture = createJsonFetchFixture({
      model: 'gpt-4.1-mini',
      choices: [{ message: { content: 'OpenAI answer' } }],
      usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
    });
    const provider = createOpenAIProvider({
      apiKey: 'key',
      model: 'gpt-4.1-mini',
      apiBase: 'https://openai.test/v1',
      fetchImpl: fixture.fetchImpl,
    });

    const result = await provider.turn({ ...turn, model: 'gpt-4.1-mini' });

    expect(fixture.calls[0]?.url).toBe('https://openai.test/v1/chat/completions');
    expect(fixture.calls[0]?.body).toMatchObject({
      model: 'gpt-4.1-mini',
      messages: [
        { role: 'system', content: 'Be useful.' },
        { role: 'user', content: 'Hello' },
      ],
      max_tokens: 64,
      temperature: 0.2,
      stream: false,
    });
    expect(result).toMatchObject({
      output_text: 'OpenAI answer',
      tokens_in: 3,
      tokens_out: 4,
      model: 'gpt-4.1-mini',
      provider: 'openai',
    });
    expect(result.raw_response).toMatchObject({ choices: [{ message: { content: 'OpenAI answer' } }] });
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
      'https://gemini.test/v1beta/models/gemini-2.5-flash:generateContent?key=key',
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

  it('maps xAI through OpenAI-compatible chat without treating it as OpenAI', async () => {
    const fixture = createJsonFetchFixture({
      model: 'grok-4-fast',
      choices: [{ message: { content: 'xAI answer' } }],
      usage: { prompt_tokens: 1, completion_tokens: 2 },
    });
    const provider = createXAIProvider({
      apiKey: 'key',
      model: 'grok-4-fast',
      apiBase: 'https://xai.test/v1',
      fetchImpl: fixture.fetchImpl,
    });

    const result = await provider.turn({ ...turn, model: 'grok-4-fast' });

    expect(fixture.calls[0]?.url).toBe('https://xai.test/v1/chat/completions');
    expect(result.provider).toBe('xai');
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
