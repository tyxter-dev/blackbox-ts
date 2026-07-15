import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  AgentRuntimeError,
  CapabilityError,
  ConfigurationError,
  ProviderExecutionError,
  RuntimeConfig,
  UnsupportedFeatureError,
  artifactPage,
  createAgentEvent,
  createAgentSession,
  createApprovalRequest,
  createArtifact,
  createProviderState,
  createRunItem,
  createRunState,
  modelUsage,
  structuredOutput,
  type AgentEventInput,
  type AgentSessionInput,
  type ArtifactInput,
  type ModelUsageInput,
  type ProviderStateInput,
  type RunItemInput,
  type RunStateInput,
} from '../../src/index.js';

type JsonRecord = Record<string, unknown>;

interface CoreFixture {
  readonly generated_by: string;
  readonly parent_commit: string;
  readonly event: JsonRecord;
  readonly run_state: JsonRecord & {
    readonly items: readonly JsonRecord[];
    readonly provider_state: JsonRecord;
  };
  readonly session: JsonRecord;
  readonly approval_request: {
    readonly action: string;
    readonly id: string;
    readonly reason: string;
    readonly data: JsonRecord;
  };
  readonly artifact: JsonRecord;
  readonly artifact_page: { readonly has_more: boolean };
  readonly usage: ModelUsageInput;
  readonly result: {
    readonly output: unknown;
    readonly text: string;
    readonly payloads: readonly unknown[];
    readonly metadata: JsonRecord;
    readonly [key: string]: unknown;
  };
  readonly runtime_config: {
    readonly overrides: JsonRecord;
    readonly [key: string]: unknown;
  };
  readonly output_spec: {
    readonly schema: unknown;
    readonly name: string;
    readonly [key: string]: unknown;
  };
  readonly error_semantics: readonly {
    readonly name: string;
    readonly message: string;
    readonly is_agent_runtime_error: boolean;
    readonly is_configuration_error: boolean;
    readonly is_capability_error: boolean;
  }[];
}

const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/python/core-contracts.json', import.meta.url), 'utf8'),
) as CoreFixture;
const inventory = JSON.parse(
  readFileSync(new URL('../../docs/parity-inventory.json', import.meta.url), 'utf8'),
) as { readonly parent: { readonly commit: string } };

describe('Python-generated core contract fixtures', () => {
  it('reproduces serialized events, state, sessions, approvals, artifacts, usage, and results', () => {
    expect(fixture.generated_by).toBe('python-parent');
    expect(fixture.parent_commit).toBe(inventory.parent.commit);

    const event = createAgentEvent(compact(fixture.event) as unknown as AgentEventInput);
    const itemFixture = fixture.run_state.items[0];
    if (itemFixture === undefined) throw new Error('Python run-state fixture has no item.');
    const item = createRunItem(compact(itemFixture) as unknown as RunItemInput);
    const state = createProviderState(
      compact(fixture.run_state.provider_state) as unknown as ProviderStateInput,
    );
    const runState = createRunState({
      ...(compact(fixture.run_state) as unknown as RunStateInput),
      provider_state: state,
      items: [item],
    });
    const session = createAgentSession(compact(fixture.session) as unknown as AgentSessionInput);
    const approval = createApprovalRequest(fixture.approval_request.action, {
      id: fixture.approval_request.id,
      reason: fixture.approval_request.reason,
      data: fixture.approval_request.data,
    });
    const artifact = createArtifact(compact(fixture.artifact) as unknown as ArtifactInput<unknown>);
    const page = artifactPage([artifact]);
    const usage = modelUsage(fixture.usage);

    expect(event).toEqual(compact(fixture.event));
    expect(item).toEqual(compact(itemFixture));
    expect(state).toEqual(compact(fixture.run_state.provider_state));
    expect(runState).toEqual({
      ...compact(fixture.run_state),
      provider_state: state,
      items: [item],
    });
    expect(session).toEqual(compact(fixture.session));
    expect(approval).toEqual(fixture.approval_request);
    expect(artifact).toEqual(compact(fixture.artifact));
    expect(page).toEqual({ items: [artifact], next_cursor: undefined, has_more: false });
    expect(fixture.artifact_page.has_more).toBe(page.has_more);
    expect(usage).toEqual(fixture.usage);
    expect(event.raw).toEqual({ id: 'resp_fixture' });

    const result = {
      output: fixture.result.output,
      text: fixture.result.text,
      events: [event],
      items: [item],
      artifacts: [artifact],
      payloads: fixture.result.payloads,
      provider_state: state,
      metadata: fixture.result.metadata,
    };
    expect({
      output: result.output,
      text: result.text,
      event_ids: result.events.map((entry) => entry.id),
      item_ids: result.items.map((entry) => entry.id),
      artifact_ids: result.artifacts.map((entry) => entry.id),
      payloads: result.payloads,
      provider_state: withNullOptionals(result.provider_state, ['conversation_id']),
      metadata: result.metadata,
    }).toEqual(fixture.result);
  });

  it('matches Python configuration and structured-output helper defaults', () => {
    const config = RuntimeConfig.fromMapping(
      { profile: 'fast_text', overrides: fixture.runtime_config.overrides },
      { source: 'fixture' },
    );
    expect({
      profile_name: config.profile_name,
      overrides: config.overrides,
      source: config.source,
      kwargs: config.toKwargs('model'),
      description: withNullOptionals(config.describe(), []),
    }).toEqual(fixture.runtime_config);

    expect(
      withNullOptionals(
        structuredOutput(fixture.output_spec.schema, { name: fixture.output_spec.name }),
        ['description'],
      ),
    ).toEqual(fixture.output_spec);
  });

  it('keeps the Python error inheritance semantics', () => {
    const errors = [
      new AgentRuntimeError('runtime'),
      new ConfigurationError('config'),
      new CapabilityError('capability'),
      new UnsupportedFeatureError('unsupported', 'unsupported'),
      new ProviderExecutionError('fixture', 500, {}),
    ];
    expect(
      errors.map((error) => ({
        name: error.name,
        is_agent_runtime_error: error instanceof AgentRuntimeError,
        is_configuration_error: error instanceof ConfigurationError,
        is_capability_error: error instanceof CapabilityError,
      })),
    ).toEqual(
      fixture.error_semantics.map((semantics) => ({
        name: semantics.name,
        is_agent_runtime_error: semantics.is_agent_runtime_error,
        is_configuration_error: semantics.is_configuration_error,
        is_capability_error: semantics.is_capability_error,
      })),
    );
  });
});

function compact(value: JsonRecord): JsonRecord {
  return Object.fromEntries(
    Object.entries(value).filter(([key, child]) => key !== '_kind' && child !== null),
  );
}

function withNullOptionals(value: object, optionalKeys: readonly string[]): JsonRecord {
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, child]) => {
      if (child !== undefined) return [[key, child]];
      return optionalKeys.includes(key) ? [[key, null]] : [];
    }),
  );
}
