import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  createAgentEvent,
  createAgentSession,
  createApprovalRequest,
  createArtifact,
  createProviderState,
  createRunItem,
  createRunState,
  deserializeDurable,
  modelUsage,
  serializeDurable,
  packWorkspaceAgent,
  unpackWorkspaceAgent,
} from '../../src/index.js';
import { buildTypeScriptFixture } from '../fixtures/typescript/build-core-fixture.js';

const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/typescript/core-contracts.json', import.meta.url), 'utf8'),
) as ReturnType<typeof buildTypeScriptFixture>;

describe('canonical TypeScript core expectations', () => {
  it('matches committed native expectations from fixed inputs and current public contracts', () => {
    expect(buildTypeScriptFixture()).toEqual(fixture);
    expect(fixture.authority).toBe('typescript');
    expect(fixture).not.toHaveProperty('target_parent_commit');
    expect(fixture.payloads.event).not.toHaveProperty('_kind');
  });

  it('replays native values through public constructors and durable serialization', () => {
    const { payloads, values } = fixture;
    const state = createProviderState(payloads.run_state.provider_state);
    const items = payloads.run_state.items.map(createRunItem);
    expect(createAgentEvent(payloads.event)).toEqual(payloads.event);
    expect(createRunState({ ...payloads.run_state, provider_state: state, items })).toEqual(
      payloads.run_state,
    );
    expect(createAgentSession(payloads.session)).toEqual(payloads.session);
    expect(createArtifact(payloads.artifact)).toEqual(payloads.artifact);
    expect(createApprovalRequest(values.approval_request.action, values.approval_request)).toEqual(
      values.approval_request,
    );
    expect(modelUsage(values.usage)).toEqual(values.usage);
    for (const [kind, value] of Object.entries(payloads)) {
      const serialized = serializeDurable(kind, value);
      expect(deserializeDurable(serialized, kind)).toEqual(value);
      expect(() => deserializeDurable(serialized, 'wrong-kind')).toThrow(/does not match/);
    }
    expect(unpackWorkspaceAgent(packWorkspaceAgent(fixture.workspace_agent)).agent).toEqual(
      fixture.workspace_agent,
    );
  });

  it('pins meaningful defaults, error inheritance and independent pricing outcomes', () => {
    expect(fixture.values.runtime_config.kwargs).toEqual({
      temperature: 0.1,
      max_output_tokens: 512,
    });
    expect(fixture.values.output_spec).toMatchObject({
      strategy: 'provider_native',
      fallback: 'posthoc_parse',
      strict: true,
      allow_partial: false,
      max_validation_retries: 1,
    });
    expect(fixture.payloads.event.raw).toEqual({ id: 'msg_ts_fixture' });
    expect(fixture.error_semantics).toEqual([
      {
        name: 'AgentRuntimeError',
        is_agent_runtime_error: true,
        is_configuration_error: false,
        is_capability_error: false,
      },
      {
        name: 'ConfigurationError',
        is_agent_runtime_error: true,
        is_configuration_error: true,
        is_capability_error: false,
      },
      {
        name: 'CapabilityError',
        is_agent_runtime_error: true,
        is_configuration_error: false,
        is_capability_error: true,
      },
      {
        name: 'UnsupportedFeatureError',
        is_agent_runtime_error: true,
        is_configuration_error: false,
        is_capability_error: true,
      },
      {
        name: 'ProviderExecutionError',
        is_agent_runtime_error: true,
        is_configuration_error: false,
        is_capability_error: false,
      },
    ]);
    expect(fixture.pricing).toMatchObject({ source_url: 'https://example.test/pricing' });
    expect(fixture.pricing_model).toBe('canonical');
    for (const [component, expected] of Object.entries({
      input: 0.0007,
      output: 0.0004,
      cache_read: 0.00005,
      cache_creation: 0.000015,
      reasoning_output: 0.000008,
    })) {
      expect(fixture.pricing.components[component]).toBeCloseTo(expected, 12);
    }
  });
});
