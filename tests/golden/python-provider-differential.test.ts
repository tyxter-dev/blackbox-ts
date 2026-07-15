import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  AgentEventTypes,
  createSSEFetchFixture,
  type AgentModelProvider,
  type TurnResult,
} from '../../src/index.js';
import { createAnthropicProvider } from '../../src/providers/anthropic/index.js';
import { createGeminiProvider } from '../../src/providers/gemini/index.js';
import { createOpenAIProvider } from '../../src/providers/openai/index.js';
import { createXAIProvider } from '../../src/providers/xai/index.js';

interface Scenario {
  readonly provider: 'openai' | 'anthropic' | 'google' | 'xai';
  readonly model: string;
  readonly wire_events: readonly unknown[];
  readonly expected: unknown;
}

const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/python/provider-differential.json', import.meta.url), 'utf8'),
) as {
  readonly parent_commit: string;
  readonly scenarios: readonly Scenario[];
};
const inventory = JSON.parse(
  readFileSync(new URL('../../docs/parity-inventory.json', import.meta.url), 'utf8'),
) as { readonly parent: { readonly commit: string } };

describe('Python provider differential fixtures', () => {
  it('replays parent protocol scenarios through every common TypeScript adapter', async () => {
    expect(fixture.parent_commit).toBe(inventory.parent.commit);

    for (const scenario of fixture.scenarios) {
      const fetchFixture = createSSEFetchFixture(
        scenario.wire_events.map((event) =>
          scenario.provider === 'anthropic'
            ? `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`
            : `data: ${JSON.stringify(event)}\n\n`,
        ),
      );
      const provider = createProvider(scenario, fetchFixture.fetchImpl);
      const result = await provider.turn({
        model: scenario.model,
        input: 'lookup 42',
        tools: [{ name: 'lookup', input_schema: { type: 'object' } }],
      });

      expect(projectResult(result), scenario.provider).toEqual(scenario.expected);
      expect(result.events?.every((event) => event.raw !== undefined)).toBe(true);
    }
  });
});

function createProvider(scenario: Scenario, fetchImpl: typeof fetch): AgentModelProvider {
  const common = { apiKey: 'fixture', model: scenario.model, fetchImpl, maxRetries: 0 };
  switch (scenario.provider) {
    case 'openai':
      return createOpenAIProvider({ ...common, apiBase: 'https://openai.fixture/v1' });
    case 'xai':
      return createXAIProvider({ ...common, apiBase: 'https://xai.fixture/v1' });
    case 'anthropic':
      return createAnthropicProvider({ ...common, apiBase: 'https://anthropic.fixture' });
    case 'google':
      return createGeminiProvider({ ...common, apiBase: 'https://google.fixture/v1beta' });
  }
}

function projectResult(result: TurnResult): unknown {
  const eventTypes = result.events?.map((event) => event.type) ?? [];
  return {
    output_text: result.output_text,
    events: {
      request_started: eventTypes.includes(AgentEventTypes.MODEL_REQUEST_STARTED),
      text_delta: eventTypes.includes(AgentEventTypes.MODEL_TEXT_DELTA),
      reasoning_delta: eventTypes.includes(AgentEventTypes.MODEL_REASONING_DELTA),
      completed: eventTypes.includes(AgentEventTypes.MODEL_COMPLETED),
    },
    items: (result.items ?? [])
      .filter((item) => item.type === 'function_call')
      .map((item) => ({
        id: item.id,
        type: item.type,
        provider: item.provider,
        name: item.data.name,
        call_id: item.data.call_id,
      })),
    usage: {
      input_tokens: result.usage?.input_tokens ?? 0,
      output_tokens: result.usage?.output_tokens ?? 0,
      total_tokens: result.usage?.total_tokens ?? 0,
      cached_input_tokens: result.usage?.cached_input_tokens ?? 0,
      cache_read_input_tokens: result.usage?.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: result.usage?.cache_creation_input_tokens ?? 0,
      reasoning_tokens: result.usage?.reasoning_tokens ?? 0,
    },
    provider_state: {
      provider: result.provider_state?.provider,
      ...(result.provider_state?.previous_response_id === undefined
        ? {}
        : { previous_response_id: result.provider_state.previous_response_id }),
    },
  };
}
