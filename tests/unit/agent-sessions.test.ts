import { describe, expect, it } from 'vitest';

import {
  AgentEventTypes,
  AgentRuntime,
  FakeModelProvider,
  FakeAgentProvider,
  InMemorySessionStore,
  ClaudeCodeAgentProvider,
  OpenAICloudAgentProvider,
  LocalAgentProvider,
  ProviderRegistry,
  ScriptedModelProvider,
  ToolRegistry,
  VertexAIAgentEngineProvider,
  allow,
  approve,
  capability,
  createRunItem,
  requireApproval,
  resolveClaudeCodeAuth,
  textCompletionCapabilityProfile,
  type CapabilityProfile,
} from '../../src/index.js';

function toolProfile(model?: string): CapabilityProfile {
  const base = textCompletionCapabilityProfile('script', model);
  return {
    ...base,
    summary: { ...base.summary, supports_function_tools: true },
    tools: { ...base.tools, function_tools: capability('supported') },
  };
}

describe('agent sessions runtime', () => {
  it('runs and durably replays the local AgentLoop provider', async () => {
    const registry = new ProviderRegistry();
    registry.registerModelProvider(
      new FakeModelProvider({ id: 'echo', outputText: 'session done' }),
    );
    const sessions = new InMemorySessionStore();
    const runtime = new AgentRuntime({ registry, session_store: sessions });
    registry.registerAgentProvider(new LocalAgentProvider(runtime));
    const agent = await runtime.agents.createAgent('local', {
      name: 'local-agent',
      model: 'echo:model',
    });
    const session = await runtime.agents.start('local', agent, {
      input: 'work',
      trace_id: 'trace_session',
    });

    const result = await runtime.agents.run(session);
    expect(result).toMatchObject({ text: 'session done', status: 'completed' });
    expect(result.events.some((event) => event.type === AgentEventTypes.SESSION_COMPLETED)).toBe(
      true,
    );
    const replayed = await runtime.agents.run(session);
    expect(replayed.events).toEqual(result.events);
    expect(sessions.load(session.id)).toMatchObject({
      session: { status: 'completed' },
    });
  });

  it('deduplicates follow-up invocation keys and keeps the Vertex stub honest', async () => {
    const registry = new ProviderRegistry();
    registry.registerModelProvider(new FakeModelProvider({ id: 'echo', outputText: 'done' }));
    const runtime = new AgentRuntime({ registry });
    registry.registerAgentProvider(new LocalAgentProvider(runtime));
    const agent = await runtime.agents.createAgent('local', { name: 'agent', model: 'echo:model' });
    const session = await runtime.agents.start('local', agent, { input: 'first' });
    await runtime.agents.run(session);

    const first = await runtime.agents.sendMessage(session, 'again', { idempotency_key: 'same' });
    const second = await runtime.agents.sendMessage(session, 'again', { idempotency_key: 'same' });
    expect(second).toEqual(first);

    const vertex = new VertexAIAgentEngineProvider();
    expect(vertex.capabilities()).toMatchObject({ supports_resume: false });
    await expect(vertex.createAgent({ name: 'unsupported' })).rejects.toMatchObject({
      code: 'unsupported_feature',
    });
  });

  it('streams local approval requests live and persists the decision before continuing', async () => {
    const call = createRunItem({
      type: 'function_call',
      provider: 'script',
      data: { name: 'publish', call_id: 'publish_1', arguments: { target: 'docs' } },
    });
    const registry = new ProviderRegistry();
    registry.registerModelProvider(
      new ScriptedModelProvider(
        [{ output_text: '', items: [call] }, { output_text: 'Published.' }],
        { id: 'script', capabilities: toolProfile },
      ),
    );
    const seen: unknown[] = [];
    const runtime = new AgentRuntime({
      registry,
      tools: new ToolRegistry([
        {
          name: 'publish',
          handler: (arguments_) => {
            seen.push(arguments_);
            return 'ok';
          },
        },
      ]),
      policy: {
        check: ({ checkpoint }) =>
          checkpoint === 'before_tool_call' ? requireApproval('review publish') : allow(),
      },
    });
    registry.registerAgentProvider(new LocalAgentProvider(runtime));
    const agent = await runtime.agents.createAgent('local', {
      name: 'publisher',
      model: 'script:model',
      metadata: { run_request: { tools: ['publish'] } },
    });
    const session = await runtime.agents.start('local', agent, { input: 'Publish docs' });

    const eventTypes: string[] = [];
    for await (const event of runtime.agents.stream(session)) {
      eventTypes.push(event.type);
      if (event.type === AgentEventTypes.APPROVAL_REQUESTED) {
        const request = event.data.request;
        if (
          typeof request !== 'object' ||
          request === null ||
          !('id' in request) ||
          typeof request.id !== 'string'
        ) {
          throw new Error('Approval request is missing its id.');
        }
        await runtime.agents.approve(session, request.id, approve('reviewed'));
      }
    }

    expect(eventTypes).toContain(AgentEventTypes.APPROVAL_REQUESTED);
    expect(eventTypes).toContain(AgentEventTypes.SESSION_COMPLETED);
    expect(seen).toEqual([{ target: 'docs' }]);
    const replay = await runtime.agents.replay(session.id);
    const approvalRecord = Object.values(replay.approvals)[0];
    expect(approvalRecord?.decision?.approved).toBe(true);
  });

  it('normalizes injected cloud-client identities and resolves Claude subscription auth', async () => {
    const client = new FakeAgentProvider('native-client');
    const openai = new OpenAICloudAgentProvider(client);
    const agent = await openai.createAgent({ name: 'cloud' });
    const session = await openai.startSession(agent, { input: 'work' });
    const events = [];
    for await (const event of openai.streamEvents(session)) events.push(event);
    const invocation = await openai.sendMessage(session, 'continue');

    expect(agent.provider).toBe('openai-agent');
    expect(session.provider).toBe('openai-agent');
    expect(events.every((event) => event.provider === 'openai-agent')).toBe(true);
    expect(invocation).toMatchObject({ provider: 'openai-agent', session_id: session.id });
    expect(openai.capabilities().supports_resume).toBe(true);
    const noResumeClient = Object.create(client) as FakeAgentProvider;
    Object.defineProperty(noResumeClient, 'resume', { value: undefined });
    const noResume = new OpenAICloudAgentProvider(noResumeClient);
    expect(noResume.capabilities().supports_resume).toBe(false);
    await expect(noResume.resume(session)).rejects.toMatchObject({ code: 'unsupported_feature' });
    expect(
      resolveClaudeCodeAuth({ auth: 'auto', env: { CLAUDE_CODE_OAUTH_TOKEN: 'secret' } }),
    ).toBe('subscription');
    expect(resolveClaudeCodeAuth({ auth: 'api_key', api_key: 'secret', env: {} })).toBe('api_key');
    expect(() => resolveClaudeCodeAuth({ auth: 'api_key', env: {} })).toThrowError(
      expect.objectContaining({ code: 'provider_not_configured' }),
    );
    expect(new ClaudeCodeAgentProvider(client, { auth: 'subscription' }).resolveAuth()).toBe(
      'subscription',
    );
  });
});
