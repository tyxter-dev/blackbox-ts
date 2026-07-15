import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { formatGenerated } from './lib/format-generated.mjs';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const outputPath = resolve(repoRoot, 'tests/fixtures/typescript/core-contracts.json');
const inventory = JSON.parse(await readFile(resolve(repoRoot, 'docs/parity-inventory.json'), 'utf8'));
const {
  RuntimeConfig,
  createAgentEvent,
  createAgentSession,
  createApprovalRequest,
  createArtifact,
  createProviderState,
  createRunItem,
  createRunState,
  modelUsage,
  structuredOutput,
} = await import('../dist/index.js');

const event = createAgentEvent({
  type: 'model.completed',
  run_id: 'run_ts_fixture',
  sequence: 4,
  trace_id: 'trace_ts_fixture',
  span_id: 'span_ts_fixture',
  provider: 'anthropic',
  provider_request_id: 'req_ts_fixture',
  data: { output_text: 'hello from TypeScript' },
  raw: { id: 'msg_ts_fixture' },
  id: 'evt_ts_fixture',
  timestamp: '2026-01-02T03:04:05+00:00',
});
const item = createRunItem({
  type: 'function_call',
  provider: 'anthropic',
  data: { name: 'lookup', call_id: 'call_ts_fixture', arguments: { id: '42' } },
  status: 'completed',
  id: 'item_ts_fixture',
});
const providerState = createProviderState({
  provider: 'anthropic',
  native_history: [{ role: 'assistant', content: 'hello from TypeScript' }],
  reasoning_state: { signature: 'sig_ts' },
  tool_state: { call_id: 'call_ts_fixture' },
  continuation: { last_message_id: 'msg_ts_fixture' },
});
const runState = createRunState({
  session_id: 'sess_ts_fixture',
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  provider_state: providerState,
  items: [item],
  metadata: { fixture: true },
});
const session = createAgentSession({
  provider: 'local',
  task: 'typescript fixture',
  agent_id: 'agent_ts_fixture',
  model: 'claude-sonnet-4-6',
  status: 'running',
  metadata: { tenant: 'dev' },
  id: 'sess_ts_fixture',
});
const artifact = createArtifact({
  type: 'report',
  name: 'typescript-result.json',
  data: { ok: true },
  metadata: { source: 'typescript' },
  id: 'art_ts_fixture',
});
const approval = createApprovalRequest('workspace.write', {
  reason: 'sensitive',
  data: { path: 'typescript.txt' },
  id: 'approval_ts_fixture',
});
const usage = modelUsage({
  input_tokens: 8,
  output_tokens: 3,
  cached_input_tokens: 2,
  cache_read_input_tokens: 2,
  reasoning_tokens: 1,
  tool_calls: 1,
  provider_details: { request_id: 'req_ts_fixture' },
});
const config = RuntimeConfig.fromMapping(
  { profile: 'fast_text', overrides: { temperature: 0.1 } },
  { source: 'typescript-fixture' },
);
const outputSpec = structuredOutput(
  { type: 'object', properties: { answer: { type: 'string' } } },
  { name: 'typescript_output' },
);

const fixture = {
  schema_version: 1,
  generated_by: 'blackbox-ts',
  target_parent_commit: inventory.parent.commit,
  payloads: {
    event: parentEvent(event),
    run_state: parentRunState(runState),
    agent_ref: {
      _kind: 'AgentRef',
      provider: 'local',
      id: 'agent_ts_fixture',
      metadata: { version: 1 },
    },
    session_ref: {
      _kind: 'SessionRef',
      provider: 'local',
      id: 'sess_ts_fixture',
      agent_id: 'agent_ts_fixture',
      metadata: { tenant: 'dev' },
    },
    invocation_ref: {
      _kind: 'InvocationRef',
      provider: 'local',
      session_id: 'sess_ts_fixture',
      id: 'invoke_ts_fixture',
      metadata: { turn: 1 },
    },
    session: { _kind: 'AgentSession', ...jsonValue(session) },
    artifact_ref: {
      _kind: 'ArtifactRef',
      id: artifact.id,
      provider: 'local',
      uri: 'artifact://art_ts_fixture',
    },
    artifact: { _kind: 'Artifact', ...jsonValue(artifact), uri: null },
  },
  values: {
    approval_request: approval,
    usage,
    runtime_config: {
      profile_name: config.profile_name,
      overrides: config.overrides,
      source: config.source,
      kwargs: config.toKwargs('model'),
    },
    output_spec: jsonValue(outputSpec),
  },
};
const rendered = await formatGenerated(`${JSON.stringify(fixture, null, 2)}\n`, outputPath);

if (process.argv.includes('--check')) {
  const current = await readFile(outputPath, 'utf8').catch(() => '');
  if (current !== rendered) {
    throw new Error('tests/fixtures/typescript/core-contracts.json is stale. Run pnpm generate:parity:ts.');
  }
  console.log('TypeScript reverse parity fixture OK.');
} else {
  await mkdir(resolve(repoRoot, 'tests/fixtures/typescript'), { recursive: true });
  await writeFile(outputPath, rendered, 'utf8');
  console.log('Generated TypeScript reverse parity fixture.');
}

function parentEvent(value) {
  return {
    _kind: 'AgentEvent',
    id: value.id,
    type: value.type,
    run_id: value.run_id ?? null,
    sequence: value.sequence ?? null,
    trace_id: value.trace_id ?? null,
    span_id: value.span_id ?? null,
    parent_span_id: value.parent_span_id ?? null,
    span_kind: value.span_kind ?? null,
    session_id: value.session_id ?? null,
    provider: value.provider ?? null,
    item_id: value.item_id ?? null,
    provider_trace_id: value.provider_trace_id ?? null,
    provider_span_id: value.provider_span_id ?? null,
    provider_request_id: value.provider_request_id ?? null,
    data: value.data,
    raw: value.raw ?? null,
    timestamp: value.timestamp,
  };
}

function parentRunState(value) {
  return {
    _kind: 'RunState',
    session_id: value.session_id,
    provider: value.provider ?? null,
    model: value.model ?? null,
    provider_state: {
      _kind: 'ProviderState',
      provider: value.provider_state.provider,
      conversation_id: value.provider_state.conversation_id ?? null,
      previous_response_id: value.provider_state.previous_response_id ?? null,
      native_history: value.provider_state.native_history,
      reasoning_state: value.provider_state.reasoning_state,
      tool_state: value.provider_state.tool_state,
      continuation: value.provider_state.continuation,
    },
    items: value.items.map((entry) => ({
      _kind: 'RunItem',
      type: entry.type,
      provider: entry.provider,
      data: entry.data,
      status: entry.status ?? null,
      id: entry.id,
      parent_id: entry.parent_id ?? null,
    })),
    metadata: value.metadata,
  };
}

function jsonValue(value) {
  return JSON.parse(JSON.stringify(value));
}
