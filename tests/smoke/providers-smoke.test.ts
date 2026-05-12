import { describe, expect, it } from 'vitest';
import { complete, type AgentModelProvider } from '../../src/index.js';
import { createAnthropicProvider } from '../../src/providers/anthropic/index.js';
import { createGeminiProvider } from '../../src/providers/gemini/index.js';
import { createOpenAIProvider } from '../../src/providers/openai/index.js';
import { createOpenRouterProvider } from '../../src/providers/openrouter/index.js';
import { createXAIProvider } from '../../src/providers/xai/index.js';

interface SmokeCase {
  readonly name: string;
  readonly env: string;
  readonly provider: () => AgentModelProvider;
}

const smokeCases: readonly SmokeCase[] = [
  {
    name: 'OpenAI',
    env: 'OPENAI_API_KEY',
    provider: () => createOpenAIProvider({ apiKey: process.env.OPENAI_API_KEY ?? '', model: 'gpt-4.1-mini' }),
  },
  {
    name: 'Anthropic',
    env: 'ANTHROPIC_API_KEY',
    provider: () =>
      createAnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY ?? '', model: 'claude-sonnet-4-5' }),
  },
  {
    name: 'Gemini',
    env: 'GOOGLE_API_KEY',
    provider: () => createGeminiProvider({ apiKey: process.env.GOOGLE_API_KEY ?? '', model: 'gemini-2.5-flash' }),
  },
  {
    name: 'xAI',
    env: 'XAI_API_KEY',
    provider: () => createXAIProvider({ apiKey: process.env.XAI_API_KEY ?? '', model: 'grok-4-fast' }),
  },
  {
    name: 'OpenRouter',
    env: 'OPENROUTER_API_KEY',
    provider: () =>
      createOpenRouterProvider({
        apiKey: process.env.OPENROUTER_API_KEY ?? '',
        model: 'openai/gpt-4.1-mini',
        appTitle: 'blackbox-ts smoke',
      }),
  },
];

describe('network-gated provider smoke tests', () => {
  for (const smoke of smokeCases) {
    const run = process.env[smoke.env] ? it : it.skip;
    run(`${smoke.name} completes one minimal text turn`, async () => {
      const result = await complete(smoke.provider(), {
        system: 'Reply with a short phrase.',
        messages: [{ role: 'user', content: 'Say hello.' }],
        trace_id: `smoke_${smoke.name.toLowerCase()}`,
      });
      expect(result.content.length).toBeGreaterThan(0);
    });
  }
});
