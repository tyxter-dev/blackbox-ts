import {
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
  PricingCatalog,
  packWorkspaceAgent,
  unpackWorkspaceAgent,
  AgentRuntimeError,
  ConfigurationError,
  CapabilityError,
  UnsupportedFeatureError,
  ProviderExecutionError,
  type WorkspaceAgentSpec,
} from '../../../src/index.js';

export function buildTypeScriptFixture() {
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

  const pricing = new PricingCatalog([
    {
      provider: 'fixture',
      model: 'canonical',
      currency: 'USD',
      source: 'fixture',
      version: '1',
      source_url: 'https://example.test/pricing',
      effective_at: '2026-01-01',
      metadata: {},
      rates: {
        input_per_million: 10,
        output_per_million: 20,
        cached_input_per_million: 3,
        cache_read_per_million: 2,
        reasoning_output_per_million: 4,
      },
    },
  ]);
  pricing.registerModelAlias('fixture', 'alias', 'canonical');
  const packageSpec: WorkspaceAgentSpec = {
    id: 'native-fixture',
    name: 'Native fixture',
    version: '1.0.0',
    instructions: 'Read carefully.',
    model: 'fixture:canonical',
    tools: ['read'],
    connectors: [],
    mcp_servers: [],
    permissions: {},
    permission_mode: 'allowlist_v1',
    grants: [{ ref: 'read', scopes: ['read'] }],
    schedules: [],
    skills: [],
    visibility: 'private',
    metadata: { fixture: true },
  };
  const errors = [
    new AgentRuntimeError('runtime'),
    new ConfigurationError('config'),
    new CapabilityError('capability'),
    new UnsupportedFeatureError('unsupported', 'unsupported'),
    new ProviderExecutionError('fixture', 500, {}),
  ];
  const fixture = {
    schema_version: 2,
    generated_by: 'blackbox-ts',
    authority: 'typescript',
    payloads: {
      event: event,
      run_state: runState,
      agent_ref: {
        provider: 'local',
        id: 'agent_ts_fixture',
        metadata: { version: 1 },
      },
      session_ref: {
        provider: 'local',
        id: 'sess_ts_fixture',
        agent_id: 'agent_ts_fixture',
        metadata: { tenant: 'dev' },
      },
      invocation_ref: {
        provider: 'local',
        session_id: 'sess_ts_fixture',
        id: 'invoke_ts_fixture',
        metadata: { turn: 1 },
      },
      session,
      artifact_ref: {
        id: artifact.id,
        provider: 'local',
        uri: 'artifact://art_ts_fixture',
      },
      artifact,
    },
    pricing_model: pricing.get('fixture', 'alias')?.model,
    pricing: pricing.estimate(
      'fixture',
      'alias',
      modelUsage({
        input_tokens: 100,
        output_tokens: 20,
        cached_input_tokens: 30,
        cache_read_input_tokens: 10,
        cache_creation_input_tokens: 5,
        reasoning_tokens: 2,
      }),
    ),
    workspace_agent: unpackWorkspaceAgent(packWorkspaceAgent(packageSpec)).agent,
    error_semantics: errors.map((error) => ({
      name: error.name,
      is_agent_runtime_error: error instanceof AgentRuntimeError,
      is_configuration_error: error instanceof ConfigurationError,
      is_capability_error: error instanceof CapabilityError,
    })),
    values: {
      approval_request: approval,
      usage,
      runtime_config: {
        profile_name: config.profile_name,
        overrides: config.overrides,
        source: config.source,
        kwargs: config.toKwargs('model'),
      },
      output_spec: outputSpec,
    },
  };

  return fixture;
}
