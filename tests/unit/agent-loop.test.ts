import { describe, expect, it, vi } from 'vitest';

import {
  AgentEventTypes,
  AgentRuntime,
  ApprovalManager,
  FakeModelProvider,
  ProviderExecutionError,
  ProviderRegistry,
  ScriptedModelProvider,
  ToolRegistry,
  allow,
  capability,
  createRunItem,
  denyPolicy,
  approve,
  requireApproval,
  structuredOutput,
  textCompletionCapabilityProfile,
  toolResult,
  type CapabilityProfile,
} from '../../src/index.js';

function toolProfile(model?: string): CapabilityProfile {
  const base = textCompletionCapabilityProfile('script', model);
  return {
    ...base,
    summary: { ...base.summary, supports_function_tools: true },
    tools: { ...base.tools, function_tools: capability('supported') },
    output: { ...base.output, finalizer_tool: capability('supported') },
  };
}

function structuredProfile(model?: string): CapabilityProfile {
  const base = toolProfile(model);
  return {
    ...base,
    summary: { ...base.summary, supports_structured_output: true },
    output: {
      ...base.output,
      structured_output: capability('supported'),
      provider_native: capability('supported'),
    },
  };
}

describe('agent loop', () => {
  it('runs model -> tool -> model, separates payloads, and collects the exact stream', async () => {
    const call = createRunItem({
      type: 'function_call',
      provider: 'script',
      status: 'completed',
      data: { name: 'lookup', call_id: 'call_1', arguments: { id: '42' } },
    });
    const provider = new ScriptedModelProvider(
      [{ output_text: '', items: [call] }, { output_text: 'The record is active.' }],
      { id: 'script', capabilities: toolProfile },
    );
    const registry = new ProviderRegistry();
    registry.registerModelProvider(provider);
    const tools = new ToolRegistry([
      {
        name: 'lookup',
        handler: ({ id }) =>
          toolResult('active', { payload: { id, status: 'active', internal: true } }),
      },
    ]);
    const runtime = new AgentRuntime({ registry, tools });

    const result = await runtime.run({
      model: 'script:model',
      input: 'Look up record 42',
      tools: ['lookup'],
      trace_id: 'trace_agent',
    });

    expect(result.output).toBe('The record is active.');
    expect(result.payloads).toEqual([
      {
        tool_name: 'lookup',
        call_id: 'call_1',
        payload: { id: '42', status: 'active', internal: true },
      },
    ]);
    expect(provider.turns).toHaveLength(2);
    expect(result.events.at(-1)?.type).toBe(AgentEventTypes.RUN_COMPLETED);
    expect(result.events.map((event) => event.sequence)).toEqual(
      result.events.map((_event, index) => index),
    );
    expect(new Set(result.events.map((event) => event.run_id)).size).toBe(1);
    expect(result.events.some((event) => event.type === AgentEventTypes.TOOL_CALL_COMPLETED)).toBe(
      true,
    );
  });

  it('repairs structured output and validates the dependency-free schema subset', async () => {
    const provider = new ScriptedModelProvider(
      [{ output_text: '{"answer":1}' }, { output_text: '{"answer":"yes"}' }],
      { id: 'script' },
    );
    const registry = new ProviderRegistry();
    registry.registerModelProvider(provider);
    const runtime = new AgentRuntime({ registry });

    const result = await runtime.run<{ answer: string }>({
      model: 'script:model',
      input: 'Answer as JSON',
      trace_id: 'trace_output',
      output: structuredOutput(
        {
          type: 'object',
          properties: { answer: { type: 'string' } },
          required: ['answer'],
          additionalProperties: false,
        },
        { strategy: 'posthoc_parse_with_retry', max_validation_retries: 1 },
      ),
    });

    expect(result.output).toEqual({ answer: 'yes' });
    expect(provider.turns).toHaveLength(2);
    expect(result.metadata.validation_attempts).toBe(2);
  });

  it('supports provider-native, finalizer, post-hoc, and configured output fallbacks', async () => {
    const schema = {
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
      additionalProperties: false,
    } as const;

    const nativeProvider = new ScriptedModelProvider([{ output_text: '{"answer":"native"}' }], {
      id: 'native',
      capabilities: structuredProfile,
    });
    const nativeRegistry = new ProviderRegistry();
    nativeRegistry.registerModelProvider(nativeProvider);
    const nativeResult = await new AgentRuntime({ registry: nativeRegistry }).run({
      model: 'native:model',
      input: 'answer',
      trace_id: 'trace_native_output',
      output: structuredOutput(schema, { strategy: 'provider_native', fallback: 'error' }),
    });
    expect(nativeResult.output).toEqual({ answer: 'native' });
    expect(nativeProvider.turns[0]?.output?.strategy).toBe('provider_native');

    const finalizerCall = createRunItem({
      type: 'function_call',
      provider: 'finalizer',
      data: {
        name: 'submit_final_output',
        call_id: 'final_1',
        arguments: { answer: 'finalized' },
      },
    });
    const finalizerProvider = new ScriptedModelProvider(
      [{ output_text: '', items: [finalizerCall] }],
      { id: 'finalizer', capabilities: toolProfile },
    );
    const finalizerRegistry = new ProviderRegistry();
    finalizerRegistry.registerModelProvider(finalizerProvider);
    const finalizerResult = await new AgentRuntime({ registry: finalizerRegistry }).run({
      model: 'finalizer:model',
      input: 'answer',
      trace_id: 'trace_finalizer_output',
      output: structuredOutput(schema, { strategy: 'finalizer_tool', fallback: 'error' }),
    });
    expect(finalizerResult.output).toEqual({ answer: 'finalized' });
    expect(finalizerProvider.turns[0]?.tools?.map((tool) => tool.name)).toContain(
      'submit_final_output',
    );

    const posthocProvider = new ScriptedModelProvider([{ output_text: '{"answer":"parsed"}' }], {
      id: 'posthoc',
    });
    const posthocRegistry = new ProviderRegistry();
    posthocRegistry.registerModelProvider(posthocProvider);
    const posthocResult = await new AgentRuntime({ registry: posthocRegistry }).run({
      model: 'posthoc:model',
      input: 'answer',
      trace_id: 'trace_posthoc_output',
      output: structuredOutput(schema, {
        strategy: 'provider_native',
        fallback: 'posthoc_parse',
      }),
    });
    expect(posthocResult.output).toEqual({ answer: 'parsed' });
    expect(posthocProvider.turns[0]?.output).toBeUndefined();
    expect(posthocResult.metadata.provider_native_fallback).toBe('posthoc_parse');
  });

  it('falls back after a provider-native schema execution failure', async () => {
    class RejectingNativeProvider extends FakeModelProvider {
      private rejected = false;
      override async turn(request: Parameters<FakeModelProvider['turn']>[0]) {
        if (!this.rejected) {
          this.rejected = true;
          this.turns.push(request);
          throw new ProviderExecutionError(this.id, 400, { error: 'schema rejected' });
        }
        return super.turn(request);
      }
    }
    const provider = new RejectingNativeProvider({
      id: 'native-reject',
      outputText: '{"answer":"recovered"}',
      capabilities: structuredProfile,
    });
    const registry = new ProviderRegistry();
    registry.registerModelProvider(provider);
    const result = await new AgentRuntime({ registry }).run({
      model: 'native-reject:model',
      input: 'answer',
      trace_id: 'trace_native_rejection',
      output: structuredOutput(
        {
          type: 'object',
          properties: { answer: { type: 'string' } },
          required: ['answer'],
        },
        { strategy: 'provider_native', fallback: 'posthoc_parse' },
      ),
    });

    expect(result.output).toEqual({ answer: 'recovered' });
    expect(provider.turns).toHaveLength(2);
    expect(provider.turns[0]?.output?.strategy).toBe('provider_native');
    expect(provider.turns[1]?.output).toBeUndefined();
    expect(result.metadata.provider_native_fallback).toBe('posthoc_parse');
  });

  it('falls back only on eligible provider/configuration failures', async () => {
    class FailingProvider extends FakeModelProvider {
      override async turn() {
        throw new ProviderExecutionError(this.id, 503, { error: 'unavailable' });
      }
    }

    const registry = new ProviderRegistry();
    registry.registerModelProvider(new FailingProvider({ id: 'primary' }));
    registry.registerModelProvider(new FakeModelProvider({ id: 'backup', outputText: 'backup' }));
    const runtime = new AgentRuntime({ registry });

    const result = await runtime.run({
      model: 'primary:model',
      fallback_providers: ['backup'],
      input: 'hello',
      trace_id: 'trace_fallback',
    });

    expect(result.text).toBe('backup');
    expect(result.metadata.fallback).toMatchObject({ provider_used: 'backup' });
  });

  it('searches and loads dynamic toolsets while preserving the visible surface', async () => {
    const functionCall = (name: string, callId: string, arguments_: Record<string, unknown>) =>
      createRunItem({
        type: 'function_call',
        provider: 'script',
        status: 'completed',
        data: { name, call_id: callId, arguments: arguments_ },
      });
    const provider = new ScriptedModelProvider(
      [
        {
          output_text: '',
          items: [functionCall('search_tools', 'search_1', { query: 'weather' })],
        },
        {
          output_text: '',
          items: [functionCall('load_tools', 'load_1', { names: ['get_weather'] })],
        },
        {
          output_text: '',
          items: [functionCall('get_weather', 'weather_1', { city: 'Recife' })],
        },
        { output_text: 'It is sunny.' },
      ],
      { id: 'script', capabilities: toolProfile },
    );
    const registry = new ProviderRegistry();
    registry.registerModelProvider(provider);
    const runtime = new AgentRuntime({ registry });

    const result = await runtime.run({
      model: 'script:model',
      input: 'Check the weather',
      tool_selection: 'dynamic',
      toolsets: [
        {
          name: 'weather',
          tools: [
            {
              name: 'get_weather',
              description: 'Get current weather for a city.',
              input_schema: { type: 'object' },
              handler: ({ city }) => toolResult(`Sunny in ${String(city)}`, { payload: { city } }),
            },
          ],
        },
      ],
      trace_id: 'trace_dynamic_tools',
    });

    expect(result.output).toBe('It is sunny.');
    expect(provider.turns[0]?.tools?.map((tool) => tool.name)).toEqual([
      'search_tools',
      'load_tools',
    ]);
    expect(provider.turns[2]?.tools?.map((tool) => tool.name)).toEqual([
      'search_tools',
      'load_tools',
      'get_weather',
    ]);
    expect(
      result.events.filter((event) => event.type === AgentEventTypes.TOOL_SET_CHANGED),
    ).toHaveLength(2);
    expect(result.metadata.tool_choice).toMatchObject({
      selection: 'dynamic',
      visible_tools: ['get_weather'],
      calls: 3,
    });
    expect(result.payloads.at(-1)?.payload).toEqual({ city: 'Recife' });
  });

  it('enforces toolset call and parallel budgets before dispatch', async () => {
    const call = createRunItem({
      type: 'function_call',
      provider: 'script',
      data: { name: 'bounded', arguments: {} },
    });
    const provider = new ScriptedModelProvider([{ output_text: '', items: [call] }], {
      id: 'script',
      capabilities: toolProfile,
    });
    const registry = new ProviderRegistry();
    registry.registerModelProvider(provider);
    const runtime = new AgentRuntime({ registry });

    await expect(
      runtime.run({
        model: 'script:model',
        input: 'run bounded tool',
        toolsets: [{ name: 'bounded', tools: [{ name: 'bounded', handler: () => 'ok' }] }],
        tool_budget: { max_calls: 0 },
        trace_id: 'trace_tool_budget',
      }),
    ).rejects.toMatchObject({ code: 'tool_budget_exceeded' });
  });

  it('pauses for approval and applies approved argument modifications', async () => {
    const call = createRunItem({
      type: 'function_call',
      provider: 'script',
      data: { name: 'transfer', call_id: 'transfer_1', arguments: { amount: 100 } },
    });
    const provider = new ScriptedModelProvider(
      [{ output_text: '', items: [call] }, { output_text: 'Transferred.' }],
      { id: 'script', capabilities: toolProfile },
    );
    const registry = new ProviderRegistry();
    registry.registerModelProvider(provider);
    const seen: unknown[] = [];
    const runtime = new AgentRuntime({
      registry,
      tools: new ToolRegistry([
        {
          name: 'transfer',
          handler: (arguments_) => {
            seen.push(arguments_);
            return 'ok';
          },
        },
      ]),
      policy: {
        check: ({ checkpoint }) =>
          checkpoint === 'before_tool_call' ? requireApproval('review') : allow(),
      },
    });
    const approvals = new ApprovalManager();
    const run = runtime.run({
      model: 'script:model',
      input: 'Transfer',
      tools: ['transfer'],
      approval_manager: approvals,
      session_id: 'session_approval',
      trace_id: 'trace_approval',
    });
    await vi.waitFor(() => expect(approvals.pending()).toHaveLength(1));
    const pending = approvals.pending()[0];
    expect(pending).toBeDefined();
    if (pending === undefined) throw new Error('Approval was not requested.');
    approvals.decide(pending.id, approve('lowered', { modified_arguments: { amount: 25 } }));

    const result = await run;
    expect(seen).toEqual([{ amount: 25 }]);
    expect(result.events.some((event) => event.type === AgentEventTypes.APPROVAL_REQUESTED)).toBe(
      true,
    );
    expect(result.events.every((event) => event.session_id === 'session_approval')).toBe(true);
  });

  it('pauses at model and final-output checkpoints and accepts a modified final value', async () => {
    const provider = new ScriptedModelProvider([{ output_text: 'original' }], { id: 'script' });
    const registry = new ProviderRegistry();
    registry.registerModelProvider(provider);
    const runtime = new AgentRuntime({
      registry,
      policy: {
        check: ({ checkpoint }) =>
          checkpoint === 'before_model_request' || checkpoint === 'before_final_output'
            ? requireApproval(checkpoint)
            : allow(),
      },
    });
    const approvals = new ApprovalManager();
    const run = runtime.run({
      model: 'script:model',
      input: 'run',
      approval_manager: approvals,
      trace_id: 'trace_checkpoint_approvals',
    });
    await vi.waitFor(() => expect(approvals.pending()).toHaveLength(1));
    const modelApproval = approvals.pending()[0];
    if (modelApproval === undefined) throw new Error('Missing model approval.');
    approvals.decide(modelApproval.id, approve());
    await vi.waitFor(() => expect(approvals.pending()).toHaveLength(1));
    const finalApproval = approvals.pending()[0];
    if (finalApproval === undefined) throw new Error('Missing final approval.');
    approvals.decide(
      finalApproval.id,
      approve('edited', { modified_arguments: { output: 'approved output' } }),
    );

    const result = await run;
    expect(result.output).toBe('approved output');
    expect(
      result.events.filter((event) => event.type === AgentEventTypes.APPROVAL_REQUESTED),
    ).toHaveLength(2);
  });

  it('emits terminal failure for iteration guards and policy denial', async () => {
    const call = createRunItem({
      type: 'function_call',
      provider: 'script',
      data: { name: 'again', arguments: {} },
    });
    const iterationProvider = new ScriptedModelProvider([{ output_text: '', items: [call] }], {
      id: 'script',
      capabilities: toolProfile,
    });
    const iterationRegistry = new ProviderRegistry();
    iterationRegistry.registerModelProvider(iterationProvider);
    const iterationRuntime = new AgentRuntime({
      registry: iterationRegistry,
      tools: new ToolRegistry([{ name: 'again', handler: () => 'again' }]),
    });

    await expect(
      iterationRuntime.run({
        model: 'script:model',
        input: 'loop',
        tools: ['again'],
        max_iterations: 1,
        trace_id: 'trace_guard',
      }),
    ).rejects.toMatchObject({ code: 'max_iterations_exceeded' });

    const deniedProvider = new ScriptedModelProvider([{ output_text: '', items: [call] }], {
      id: 'script',
      capabilities: toolProfile,
    });
    const deniedRegistry = new ProviderRegistry();
    deniedRegistry.registerModelProvider(deniedProvider);
    const deniedRuntime = new AgentRuntime({
      registry: deniedRegistry,
      tools: new ToolRegistry([{ name: 'again', handler: () => 'never' }]),
      policy: { check: () => denyPolicy('blocked') },
    });

    await expect(
      deniedRuntime.run({
        model: 'script:model',
        input: 'deny',
        tools: ['again'],
        trace_id: 'trace_policy',
      }),
    ).rejects.toMatchObject({ code: 'policy_denied' });
  });

  it('cancels active tool handlers instead of continuing with an error result', async () => {
    const call = createRunItem({
      type: 'function_call',
      provider: 'script',
      data: { name: 'wait', call_id: 'wait_1', arguments: {} },
    });
    const provider = new ScriptedModelProvider([{ output_text: '', items: [call] }], {
      id: 'script',
      capabilities: toolProfile,
    });
    const registry = new ProviderRegistry();
    registry.registerModelProvider(provider);
    let started!: () => void;
    const handlerStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const runtime = new AgentRuntime({
      registry,
      tools: new ToolRegistry([
        {
          name: 'wait',
          handler: (_arguments, context) =>
            new Promise((_resolve, reject) => {
              started();
              context.signal.addEventListener(
                'abort',
                () =>
                  reject(
                    context.signal.reason instanceof Error
                      ? context.signal.reason
                      : new Error('Tool call cancelled.'),
                  ),
                { once: true },
              );
            }),
        },
      ]),
    });
    const controller = new AbortController();
    const run = runtime.run({
      model: 'script:model',
      input: 'wait',
      tools: ['wait'],
      signal: controller.signal,
      trace_id: 'trace_cancel',
    });
    await handlerStarted;
    controller.abort(new Error('caller cancelled'));

    await expect(run).rejects.toMatchObject({ code: 'run_cancelled' });
    expect(provider.turns).toHaveLength(1);
  });
});
