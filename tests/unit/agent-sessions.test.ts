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
  createAgentEvent,
  requireApproval,
  resolveClaudeCodeAuth,
  textCompletionCapabilityProfile,
  type CapabilityProfile,
  type InjectedCloudAgentClient,
  type TaskSpec,
  type TurnRequest,
  type TurnResult,
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

  it.each(['continuous', 'resumed'] as const)(
    'keeps cancellation terminal with a %s consumer',
    async (consumer) => {
      let entered!: () => void;
      let release!: () => void;
      const modelEntered = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const modelReleased = new Promise<void>((resolve) => {
        release = resolve;
      });
      class WaitingModel extends FakeModelProvider {
        override async turn(request: TurnRequest): Promise<TurnResult> {
          entered();
          await modelReleased;
          return super.turn(request);
        }
      }
      const registry = new ProviderRegistry();
      registry.registerModelProvider(new WaitingModel());
      const runtime = new AgentRuntime({ registry });
      registry.registerAgentProvider(new LocalAgentProvider(runtime));
      const agent = await runtime.agents.createAgent('local', {
        name: 'agent',
        model: 'fake:model',
      });
      const session = await runtime.agents.start('local', agent, { input: 'work' });
      await modelEntered;
      await runtime.agents.cancel(session);
      await runtime.agents.cancel(session);
      let cancellationId: string | undefined;
      if (consumer === 'resumed') {
        for await (const event of runtime.agents.stream(session)) {
          if (event.type === AgentEventTypes.SESSION_CANCELLED) {
            cancellationId = event.id;
            break;
          }
        }
        expect(cancellationId).toBeDefined();
        expect((await runtime.agents.replay(session.id)).events.at(-1)?.id).toBe(cancellationId);
      }
      release();
      if (consumer === 'resumed') {
        const remaining = [];
        for await (const event of runtime.agents.stream(session, {
          after_event_id: cancellationId,
        })) {
          remaining.push(event);
        }
        expect(remaining.map((event) => event.type)).toEqual([AgentEventTypes.RUN_FAILED]);
      }

      const result = await runtime.agents.run(session);
      expect(result.status).toBe('cancelled');
      expect(
        result.events.filter((event) => event.type === AgentEventTypes.SESSION_CANCELLED),
      ).toHaveLength(1);
      expect(result.events.at(-1)?.type).toBe(AgentEventTypes.RUN_FAILED);
      expect(result.events.some((event) => event.type === AgentEventTypes.SESSION_FAILED)).toBe(
        false,
      );
      expect((await runtime.agents.replay(session.id)).session.status).toBe('cancelled');
      expect(await runtime.agents.run(session)).toEqual(result);
    },
  );

  it.each(['allow', 'approval'] as const)(
    'retains trailing %s diagnostics after cancellation during final-output policy',
    async (verdict) => {
      let entered!: () => void;
      let release!: () => void;
      const policyEntered = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const policyReleased = new Promise<void>((resolve) => {
        release = resolve;
      });
      const registry = new ProviderRegistry();
      registry.registerModelProvider(new FakeModelProvider());
      const runtime = new AgentRuntime({
        registry,
        policy: {
          check: async ({ checkpoint }) => {
            if (checkpoint !== 'before_final_output') return allow();
            entered();
            await policyReleased;
            return verdict === 'allow' ? allow() : requireApproval('review output');
          },
        },
      });
      const local = new LocalAgentProvider(runtime);
      registry.registerAgentProvider(local);
      const agent = await runtime.agents.createAgent('local', {
        name: 'agent',
        model: 'fake:model',
      });
      const session = await runtime.agents.start('local', agent, { input: 'work' });
      await policyEntered;
      await runtime.agents.cancel(session);
      release();
      const streamed = [];
      for await (const event of runtime.agents.stream(session)) streamed.push(event);
      const providerEvents = [];
      for await (const event of local.streamEvents(session)) providerEvents.push(event);
      expect(streamed).toEqual(providerEvents);
      expect(streamed.some((event) => event.raw !== undefined)).toBe(true);
      const cancelledIndex = streamed.findIndex(
        (event) => event.type === AgentEventTypes.SESSION_CANCELLED,
      );
      expect(cancelledIndex).toBeGreaterThanOrEqual(0);
      expect(streamed.slice(cancelledIndex + 1).map((event) => event.type)).toEqual(
        verdict === 'allow'
          ? [AgentEventTypes.RUN_COMPLETED]
          : [AgentEventTypes.APPROVAL_REQUESTED, AgentEventTypes.RUN_FAILED],
      );
      const result = await runtime.agents.run(session);
      expect(result.status).toBe('cancelled');
      expect(result.events).toEqual(streamed);
      expect((await runtime.agents.replay(session.id)).session.status).toBe('cancelled');
    },
  );

  it('cancels an outstanding approval without executing the protected action', async () => {
    const registry = new ProviderRegistry();
    const model = new FakeModelProvider();
    registry.registerModelProvider(model);
    const runtime = new AgentRuntime({
      registry,
      policy: {
        check: ({ checkpoint }) =>
          checkpoint === 'before_model_request' ? requireApproval('review model') : allow(),
      },
    });
    registry.registerAgentProvider(new LocalAgentProvider(runtime));
    const agent = await runtime.agents.createAgent('local', { name: 'agent', model: 'fake:model' });
    const session = await runtime.agents.start('local', agent, { input: 'work' });
    const events = [];
    for await (const event of runtime.agents.stream(session)) {
      events.push(event);
      if (event.type === AgentEventTypes.APPROVAL_REQUESTED) await runtime.agents.cancel(session);
    }
    expect(events.map((event) => event.type)).toContain(AgentEventTypes.SESSION_CANCELLED);
    expect(events.at(-1)?.type).toBe(AgentEventTypes.RUN_FAILED);
    expect(model.turns).toHaveLength(0);
    const replay = await runtime.agents.replay(session.id);
    expect(replay.session.status).toBe('cancelled');
    expect(Object.values(replay.approvals)).toHaveLength(1);
    expect(Object.values(replay.approvals)[0]?.decision).toBeUndefined();
    expect((await runtime.agents.run(session)).status).toBe('cancelled');
  });

  it('keeps genuine local model failures distinct from cancellation', async () => {
    class FailingModel extends FakeModelProvider {
      override async turn(): Promise<TurnResult> {
        throw new Error('model failed');
      }
    }
    const registry = new ProviderRegistry();
    registry.registerModelProvider(new FailingModel());
    const runtime = new AgentRuntime({ registry });
    registry.registerAgentProvider(new LocalAgentProvider(runtime));
    const agent = await runtime.agents.createAgent('local', { name: 'agent', model: 'fake:model' });
    const session = await runtime.agents.start('local', agent, { input: 'work' });
    const result = await runtime.agents.run(session);
    expect(result.status).toBe('failed');
    expect(result.events.at(-1)).toMatchObject({
      type: AgentEventTypes.SESSION_FAILED,
      data: { error: 'model failed' },
    });
    expect(result.events.some((event) => event.type === AgentEventTypes.SESSION_CANCELLED)).toBe(
      false,
    );
    expect(await runtime.agents.run(session)).toEqual(result);
  });

  it.each(['fresh-local', 'no-provider'] as const)(
    'replays persisted cancellation with a %s runtime',
    async (providerState) => {
      const store = new InMemorySessionStore();
      const registry = new ProviderRegistry();
      const runtime = new AgentRuntime({ registry, session_store: store });
      registry.registerModelProvider(new FakeModelProvider());
      registry.registerAgentProvider(new LocalAgentProvider(runtime));
      const agent = await runtime.agents.createAgent('local', {
        name: 'agent',
        model: 'fake:model',
      });
      const session = await runtime.agents.start('local', agent, { input: 'work' });
      await runtime.agents.cancel(session);
      const original = await runtime.agents.run(session);
      const freshRegistry = new ProviderRegistry();
      const fresh = new AgentRuntime({ registry: freshRegistry, session_store: store });
      if (providerState === 'fresh-local')
        freshRegistry.registerAgentProvider(new LocalAgentProvider(fresh));
      const replayed = [];
      for await (const event of fresh.agents.stream(session)) replayed.push(event);
      expect(replayed).toEqual(original.events);
      expect(await fresh.agents.replay(session.id)).toEqual(
        await runtime.agents.replay(session.id),
      );
    },
  );

  it.each([
    AgentEventTypes.SESSION_CANCELLED,
    AgentEventTypes.SESSION_COMPLETED,
    AgentEventTypes.SESSION_FAILED,
  ])('replays remote %s without reopening its stream', async (terminal) => {
    let opened = 0;
    class TerminalProvider extends FakeAgentProvider {
      override async *streamEvents() {
        opened += 1;
        yield createAgentEvent({ type: terminal, provider: this.id });
      }
    }
    const registry = new ProviderRegistry();
    registry.registerAgentProvider(new TerminalProvider());
    const runtime = new AgentRuntime({ registry });
    const agent = await runtime.agents.createAgent('fake-agent', { name: 'remote' });
    const session = await runtime.agents.start('fake-agent', agent, { input: 'work' });
    const result = await runtime.agents.run(session);
    expect(await runtime.agents.run(session)).toEqual(result);
    expect(opened).toBe(1);
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

  it('admits only an exact bounded Claude task_budget before the injected client is called', async () => {
    const started: TaskSpec[] = [];
    const unused = () => {
      throw new Error('unused');
    };
    const client = {
      createAgent: async () => ({ provider: 'native-client', id: 'agent', metadata: {} }),
      startSession: async (_agent: unknown, task: TaskSpec) => {
        started.push(task);
        return { provider: 'native-client', id: 'session', agent_id: 'agent', metadata: {} };
      },
      streamEvents: unused,
      sendMessage: unused,
      approve: unused,
      cancel: unused,
      listArtifacts: unused,
    } as unknown as InjectedCloudAgentClient;
    const provider = new ClaudeCodeAgentProvider(client, { auth: 'subscription' });
    const agent = await provider.createAgent({ name: 'coder' });
    const message =
      "task_budget must be exactly {'total': <positive int>} and no greater than 1000000.";

    // (parent) tests/runtime/test_claude_code_agent_provider.py L271-296 plus the
    // JavaScript shapes the parent cannot spell (arrays, null, undefined, 1.5).
    const rejected: Record<string, unknown> = {
      string: '1024',
      empty_object: {},
      boolean_total: { total: true },
      string_total: { total: '1024' },
      zero: { total: 0 },
      negative: { total: -1 },
      over_cap: { total: 1_000_001 },
      extra_key: { total: 1024, unreviewed: 1 },
      float_total: { total: 1.5 },
      nan_total: { total: Number.NaN },
      infinite_total: { total: Number.POSITIVE_INFINITY },
      array: [1024],
      null: null,
      undefined_value: undefined,
      missing_total: { max: 1024 },
    };
    for (const [name, value] of Object.entries(rejected)) {
      await expect(
        provider.startSession(agent, { input: name, metadata: { task_budget: value } }),
        name,
      ).rejects.toMatchObject({ code: 'configuration_error', message });
    }
    expect(started).toEqual([]);

    // (parent) L260-268: the boundaries are admitted; the task reaches the
    // client untouched, and so does a task without any budget.
    const untouched: TaskSpec = { input: 'plain', metadata: { other: 1 } };
    for (const task of [
      { input: 'one', metadata: { task_budget: { total: 1 } } },
      { input: 'cap', metadata: { task_budget: { total: 1_000_000 } } },
      untouched,
      { input: 'bare' },
    ]) {
      const session = await provider.startSession(agent, task);
      expect(session.provider).toBe('claude-code');
      expect(started.at(-1)).toBe(task);
    }
    expect(started).toHaveLength(4);
    // The OpenAI wrapper has no budget contract and forwards the task as-is.
    const openai = new OpenAICloudAgentProvider(client);
    await openai.startSession(agent, { input: 'x', metadata: { task_budget: '1024' } });
    expect(started).toHaveLength(5);
  });
});
