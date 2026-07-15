import { describe, expect, it } from 'vitest';
import {
  assertTurnRequestCapabilities,
  capability,
  textCompletionCapabilityProfile,
  UnsupportedCapabilityError,
  type TurnRequest,
} from '../../src/index.js';

describe('capability assertions', () => {
  const baseRequest: TurnRequest = {
    model: 'gpt-4.1-mini',
    input: 'hello',
    trace_id: 'trace_1',
  };

  it('throws before provider dispatch for unsupported MCP, tools, workspaces, and structured output', () => {
    const profile = textCompletionCapabilityProfile('openai', 'gpt-4.1-mini');

    expect(() =>
      assertTurnRequestCapabilities(
        'openai',
        { ...baseRequest, tools: [{ name: 'lookup' }] },
        profile,
      ),
    ).toThrow(UnsupportedCapabilityError);
    expect(() =>
      assertTurnRequestCapabilities(
        'openai',
        { ...baseRequest, mcp_connections: [{ id: 'docs', transport: 'http' }] },
        profile,
      ),
    ).toThrow(UnsupportedCapabilityError);
    expect(() =>
      assertTurnRequestCapabilities(
        'openai',
        { ...baseRequest, workspace: { kind: 'local' } },
        profile,
      ),
    ).toThrow(UnsupportedCapabilityError);
    expect(() =>
      assertTurnRequestCapabilities(
        'openai',
        {
          ...baseRequest,
          response_format: { type: 'json_schema', name: 'Answer', schema: { type: 'object' } },
        },
        profile,
      ),
    ).toThrow(UnsupportedCapabilityError);
  });

  it('allows passthrough only for an explicitly raw provider-native surface', () => {
    const profile = {
      ...textCompletionCapabilityProfile('provider', 'model'),
      hosted_tools: {
        ...textCompletionCapabilityProfile('provider', 'model').hosted_tools,
        raw: capability('passthrough'),
      },
    };

    expect(() =>
      assertTurnRequestCapabilities(
        'provider',
        { ...baseRequest, hosted_tools: [{ type: 'raw', config: { provider_payload: true } }] },
        profile,
      ),
    ).not.toThrow();

    expect(() =>
      assertTurnRequestCapabilities(
        'provider',
        { ...baseRequest, tools: [{ name: 'lookup' }] },
        {
          ...profile,
          tools: { function_tools: capability('passthrough') },
        },
      ),
    ).toThrow(UnsupportedCapabilityError);
  });
});
