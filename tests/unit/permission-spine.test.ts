import { describe, expect, it, vi } from 'vitest';

import {
  AgentEventTypes,
  AgentRuntime,
  ApprovalManager,
  FakeAgentProvider,
  FakeRealtimeProvider,
  ProviderRegistry,
  ScriptedModelProvider,
  ToolRegistry,
  ToolRuntime,
  allow,
  approve,
  capability,
  compilePackagePermissions,
  createAgentEvent,
  createRunItem,
  denyPolicy,
  requireApproval,
  structuredOutput,
  textCompletionCapabilityProfile,
  toolResult,
  type AgentEvent,
  type CapabilityProfile,
  type PolicyRequest,
  type ScriptedTurn,
  type SessionRef,
  type ToolHandler,
} from '../../src/index.js';
import {
  activePermissions,
  packageCallApproved,
  permissionBoundary,
  toolRequest,
  type PackagePermissions,
} from '../../src/core/tool-permissions.js';

/** A provider that admits everything this spine exercises. */
function spineProfile(model?: string): CapabilityProfile {
  const base = textCompletionCapabilityProfile('script', model);
  return {
    ...base,
    summary: {
      ...base.summary,
      supports_function_tools: true,
      supports_hosted_tools: true,
      supports_structured_output: true,
    },
    tools: { ...base.tools, function_tools: capability('supported') },
    hosted_tools: {
      ...base.hosted_tools,
      hosted_tools: capability('supported'),
      web_search: capability('supported'),
    },
    output: {
      ...base.output,
      structured_output: capability('supported'),
      finalizer_tool: capability('supported'),
    },
    controls: { ...base.controls, tool_search: capability('supported') },
  };
}

/**
 * The parent fixture: a granted `read` and an ungranted `write`.
 *
 * Both handlers record how many permission frames were active when they ran.
 * That is the only place a boundary is observable from inside a generator the
 * test drives from outside it, so it is what the stream-wrap cases assert on.
 */
function fixture(script: readonly ScriptedTurn[]): {
  runtime: AgentRuntime;
  provider: ScriptedModelProvider;
  effects: string[];
  observed: number[];
  tools: ToolRegistry;
} {
  const effects: string[] = [];
  const observed: number[] = [];
  const provider = new ScriptedModelProvider(script, { id: 'script', capabilities: spineProfile });
  const registry = new ProviderRegistry();
  registry.registerModelProvider(provider);
  const tools = new ToolRegistry([
    {
      name: 'read',
      scopes: ['read'],
      metadata: {},
      handler: () => {
        observed.push(activePermissions().length);
        effects.push('read');
        return 'allowed';
      },
    },
    {
      name: 'write',
      scopes: ['write'],
      metadata: {},
      handler: () => {
        observed.push(activePermissions().length);
        effects.push('write');
        return 'bad';
      },
    },
  ]);
  return { runtime: new AgentRuntime({ registry, tools }), provider, effects, observed, tools };
}

function callTurn(name: string, callId: string, arguments_: Record<string, unknown> = {}) {
  return {
    output_text: '',
    items: [
      createRunItem({
        type: 'function_call',
        provider: 'script',
        data: { name, call_id: callId, arguments: arguments_ },
      }),
    ],
  };
}

function grants(...refs: readonly string[]): readonly PackagePermissions[] {
  return [
    compilePackagePermissions(
      refs.map((ref) => ({ ref })),
      [],
    ),
  ];
}

function toolNames(turn: { readonly tools?: readonly { readonly name: string }[] }): string[] {
  return (turn.tools ?? []).map((tool) => tool.name);
}

const answerSchema = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
  additionalProperties: false,
} as const;

describe('permission spine exposure', () => {
  it('hides a denied tool from the model while the finalizer stays visible', async () => {
    const { runtime, provider, effects } = fixture([
      callTurn('submit_final_output', 'final_1', { answer: 'done' }),
    ]);

    const result = await permissionBoundary(grants(), async () =>
      runtime.run({
        model: 'script:model',
        input: 'go',
        tools: ['read', 'write'],
        trace_id: 'trace_exposure_denied',
        output: structuredOutput(answerSchema, { strategy: 'finalizer_tool', fallback: 'error' }),
      }),
    );

    expect(result.output).toEqual({ answer: 'done' });
    expect(toolNames(provider.turns[0]!)).toEqual(['submit_final_output']);
    expect(effects).toEqual([]);
  });

  it('exposes only the granted tool of a wider selection', async () => {
    const { runtime, provider } = fixture([{ output_text: 'done' }]);

    await permissionBoundary(grants('read'), async () =>
      runtime.run({
        model: 'script:model',
        input: 'go',
        tools: ['read', 'write'],
        trace_id: 'trace_exposure_granted',
      }),
    );

    expect(toolNames(provider.turns[0]!)).toEqual(['read']);
  });

  it('exposes every selected tool when no boundary is active', async () => {
    const { runtime, provider } = fixture([{ output_text: 'done' }]);

    await runtime.run({
      model: 'script:model',
      input: 'go',
      tools: ['read', 'write'],
      trace_id: 'trace_exposure_inert',
    });

    expect(activePermissions()).toEqual([]);
    expect(toolNames(provider.turns[0]!)).toEqual(['read', 'write']);
  });
});

describe('permission spine routing', () => {
  const discoveryScript = [
    callTurn('search_tools', 'search_1', { query: 'read write' }),
    callTurn('load_tools', 'load_1', { names: ['write'] }),
    { output_text: 'done' },
  ];

  function toolsets(tools: ToolRegistry) {
    return [{ name: 'default', tools: [tools.get('read'), tools.get('write')] }];
  }

  it('keeps a denied tool out of discovery and refuses to load it', async () => {
    const { runtime, provider, effects, tools } = fixture(discoveryScript);

    const result = await permissionBoundary(grants('read'), async () =>
      runtime.run({
        model: 'script:model',
        input: 'go',
        toolsets: toolsets(tools),
        tool_selection: 'dynamic',
        trace_id: 'trace_routing_denied',
      }),
    );

    const search = result.payloads.find((payload) => payload.tool_name === 'search_tools');
    const load = result.payloads.find((payload) => payload.tool_name === 'load_tools');
    expect(JSON.stringify(search?.payload)).not.toContain('write');
    expect(load?.payload).toMatchObject({ denied: ['write'], reason: 'denied_by_package' });
    expect(provider.turns.every((turn) => !toolNames(turn).includes('write'))).toBe(true);
    expect(effects).toEqual([]);
  });

  it('loads and exposes the same tool when no boundary is active', async () => {
    const { runtime, provider, tools } = fixture(discoveryScript);

    const result = await runtime.run({
      model: 'script:model',
      input: 'go',
      toolsets: toolsets(tools),
      tool_selection: 'dynamic',
      trace_id: 'trace_routing_inert',
    });

    const search = result.payloads.find((payload) => payload.tool_name === 'search_tools');
    const load = result.payloads.find((payload) => payload.tool_name === 'load_tools');
    expect(JSON.stringify(search?.payload)).toContain('write');
    expect(load?.payload).not.toHaveProperty('denied');
    expect(toolNames(provider.turns.at(-1)!)).toContain('write');
  });

  it('lists, loads and dispatches a granted tool under a boundary', async () => {
    const { runtime, provider, effects, tools } = fixture([
      callTurn('search_tools', 'search_1', { query: 'read' }),
      callTurn('load_tools', 'load_1', { names: ['read'] }),
      callTurn('read', 'read_1'),
      { output_text: 'done' },
    ]);

    const result = await permissionBoundary(grants('read'), async () =>
      runtime.run({
        model: 'script:model',
        input: 'go',
        toolsets: toolsets(tools),
        tool_selection: 'dynamic',
        trace_id: 'trace_routing_granted',
      }),
    );

    const search = result.payloads.find((payload) => payload.tool_name === 'search_tools');
    const load = result.payloads.find((payload) => payload.tool_name === 'load_tools');
    expect(JSON.stringify(search?.payload)).toContain('read');
    expect(load?.payload).not.toHaveProperty('denied');
    expect(load?.payload).toMatchObject({ visible_tools: ['read'] });
    expect(toolNames(provider.turns.at(-1)!)).toContain('read');
    expect(effects).toEqual(['read']);
  });

  it('keeps the discovery meta tools callable inside a boundary', async () => {
    const { runtime, effects, tools } = fixture([
      callTurn('search_tools', 'search_1', { query: 'read' }),
      { output_text: 'done' },
    ]);

    const result = await permissionBoundary(grants(), async () =>
      runtime.run({
        model: 'script:model',
        input: 'go',
        toolsets: toolsets(tools),
        tool_selection: 'dynamic',
        trace_id: 'trace_routing_meta',
      }),
    );

    expect(
      result.items.some((item) => item.type === 'function_result' && item.status === 'completed'),
    ).toBe(true);
    expect(effects).toEqual([]);
  });
});

describe('permission spine dispatch', () => {
  it('denies a call at dispatch and reports it as a rejected tool choice', async () => {
    const { runtime, effects } = fixture([callTurn('write', 'write_1'), { output_text: 'done' }]);

    const result = await permissionBoundary(grants('read'), async () =>
      runtime.run({
        model: 'script:model',
        input: 'go',
        tools: ['read', 'write'],
        trace_id: 'trace_dispatch_denied',
      }),
    );

    const failed = result.items.find((item) => item.type === 'function_result');
    expect(failed?.status).toBe('failed');
    expect(failed?.data.is_error).toBe(true);
    expect(String(failed?.data.content)).toContain('local:write');
    const rejected = result.events.find(
      (event) => event.type === AgentEventTypes.TOOL_CHOICE_REJECTED,
    );
    expect(rejected?.data).toMatchObject({
      name: 'write',
      call_id: 'write_1',
      checkpoint: 'before_tool_call',
    });
    expect(result.events.some((event) => event.type === AgentEventTypes.TOOL_CALL_FAILED)).toBe(
      true,
    );
    expect(effects).toEqual([]);
  });

  it('admits a plain granted call end to end with no approval at all', async () => {
    const { runtime, effects, observed } = fixture([
      callTurn('read', 'read_1'),
      { output_text: 'done' },
    ]);

    const result = await permissionBoundary(grants('read'), async () =>
      runtime.run({
        model: 'script:model',
        input: 'go',
        tools: ['read', 'write'],
        trace_id: 'trace_dispatch_plain_grant',
      }),
    );

    expect(effects).toEqual(['read']);
    expect(observed).toEqual([1]);
    expect(result.output).toBe('done');
    expect(result.items.find((item) => item.type === 'function_result')?.status).toBe('completed');
    expect(result.events.some((event) => event.type === AgentEventTypes.TOOL_CHOICE_REJECTED)).toBe(
      false,
    );
  });

  it('emits no rejected-choice event for a handler-reported denial outside a boundary', async () => {
    // Only an enforced dispatch may raise the package rejection event; a
    // handler that merely returns the same metadata string must not.
    const { runtime } = fixture([callTurn('impostor', 'impostor_1'), { output_text: 'done' }]);

    const result = await runtime.run({
      model: 'script:model',
      input: 'go',
      tools: [
        {
          name: 'impostor',
          handler: () =>
            toolResult('nope', {
              is_error: true,
              metadata: { error: 'denied_by_policy', reason: 'not really' },
            }),
        },
      ],
      trace_id: 'trace_impostor_denial',
    });

    expect(activePermissions()).toEqual([]);
    expect(result.events.some((event) => event.type === AgentEventTypes.TOOL_CALL_FAILED)).toBe(
      true,
    );
    expect(result.events.some((event) => event.type === AgentEventTypes.TOOL_CHOICE_REJECTED)).toBe(
      false,
    );
  });

  it('records the approval key when only the user policy asked for approval', async () => {
    // Mirrors A5's nested-checkpoint case at the spine level: an approval the
    // package never asked for still opens the dispatch, so a nested package
    // checkpoint inside the handler sees it as approved.
    const { runtime, tools, effects } = fixture([
      callTurn('read', 'read_1'),
      { output_text: 'done' },
    ]);
    const seen: boolean[] = [];
    const registered = tools.get('read') as { handler?: ToolHandler };
    const original = registered.handler!;
    registered.handler = (arguments_, context) => {
      seen.push(packageCallApproved(toolRequest(tools.get('read'))));
      return original(arguments_, context);
    };
    const approvals = new ApprovalManager();

    const run = permissionBoundary(grants('read'), async () =>
      runtime.run({
        model: 'script:model',
        input: 'go',
        tools: ['read'],
        approval_manager: approvals,
        policy: {
          check: ({ checkpoint }) =>
            checkpoint === 'before_tool_call' ? requireApproval('user asks') : allow(),
        },
        trace_id: 'trace_user_approval_key',
      }),
    );
    await vi.waitFor(() => expect(approvals.pending()).toHaveLength(1));
    approvals.decide(approvals.pending()[0]!.id, approve());
    await run;

    expect(seen).toEqual([true]);
    expect(effects).toEqual(['read']);
  });

  it('admits a granted call end to end once its approval is recorded', async () => {
    const { runtime, effects } = fixture([callTurn('read', 'read_1'), { output_text: 'done' }]);
    const approvals = new ApprovalManager();
    const boundary = [
      compilePackagePermissions([{ ref: 'read', approval: { mode: 'always' } }], []),
    ];

    const run = permissionBoundary(boundary, async () =>
      runtime.run({
        model: 'script:model',
        input: 'go',
        tools: ['read'],
        approval_manager: approvals,
        trace_id: 'trace_dispatch_admitted',
      }),
    );
    await vi.waitFor(() => expect(approvals.pending()).toHaveLength(1));
    approvals.decide(approvals.pending()[0]!.id, approve());
    const result = await run;

    expect(effects).toEqual(['read']);
    expect(result.output).toBe('done');
    expect(result.events.some((event) => event.type === AgentEventTypes.APPROVAL_REQUESTED)).toBe(
      true,
    );
    expect(result.events.some((event) => event.type === AgentEventTypes.TOOL_CHOICE_REJECTED)).toBe(
      false,
    );
  });

  it('refuses a dispatch whose callable changed while the approval was pending', async () => {
    const { runtime, effects, tools } = fixture([
      callTurn('read', 'read_1'),
      { output_text: 'done' },
    ]);
    const approvals = new ApprovalManager();
    const boundary = [
      compilePackagePermissions([{ ref: 'read', approval: { mode: 'always' } }], []),
    ];
    const registered = tools.get('read') as { handler?: ToolHandler };

    const run = permissionBoundary(boundary, async () =>
      runtime.run({
        model: 'script:model',
        input: 'go',
        tools: ['read'],
        approval_manager: approvals,
        trace_id: 'trace_dispatch_replaced',
      }),
    );
    await vi.waitFor(() => expect(approvals.pending()).toHaveLength(1));
    registered.handler = () => {
      effects.push('replaced');
      return 'bad';
    };
    approvals.decide(approvals.pending()[0]!.id, approve());
    const result = await run;

    expect(effects).toEqual([]);
    expect(result.items.find((item) => item.type === 'function_result')?.status).toBe('failed');
  });

  it('fails closed when an approved definition has no callable to key on', async () => {
    // approvalKey falls back to the definition object when there is no
    // handler, and dispatch keys on its own copy of that object, so the key
    // recorded at approval time cannot match -- even a mocked dispatch is
    // refused rather than admitted on a stale key.
    const { runtime, effects } = fixture([
      callTurn('handlerless', 'call_1'),
      { output_text: 'done' },
    ]);
    const approvals = new ApprovalManager();
    const boundary = [
      compilePackagePermissions([{ ref: 'handlerless', approval: { mode: 'always' } }], []),
    ];

    const run = permissionBoundary(boundary, async () =>
      runtime.run({
        model: 'script:model',
        input: 'go',
        tools: [{ name: 'handlerless', scopes: ['read'] }],
        approval_manager: approvals,
        mock_tools: true,
        trace_id: 'trace_dispatch_handlerless',
      }),
    );
    await vi.waitFor(() => expect(approvals.pending()).toHaveLength(1));
    approvals.decide(approvals.pending()[0]!.id, approve());
    const result = await run;

    const failed = result.items.find((item) => item.type === 'function_result');
    expect(failed?.status).toBe('failed');
    expect(failed?.data.content).toBe('Package permission denied.');
    expect(result.events.some((event) => event.type === AgentEventTypes.TOOL_CHOICE_REJECTED)).toBe(
      true,
    );
    expect(effects).toEqual([]);
  });
});

describe('permission spine model configuration', () => {
  const webSearch = { type: 'web_search' } as const;

  it('admits a granted hosted tool, drops an ungranted one, and fails closed on opaque config', async () => {
    const { runtime, provider } = fixture([{ output_text: 'a' }, { output_text: 'b' }]);
    const run = (permissions: readonly PackagePermissions[], extra?: Record<string, unknown>) =>
      permissionBoundary(permissions, async () =>
        runtime.run({
          model: 'script:model',
          input: 'go',
          hosted_tools: [webSearch],
          extra,
          trace_id: 'trace_hosted',
        }),
      );

    await run(grants('hosted:web_search'));
    expect(provider.turns[0]?.hosted_tools).toEqual([webSearch]);
    await run(grants());
    expect(provider.turns[1]?.hosted_tools).toEqual([]);

    await expect(
      permissionBoundary(grants('hosted:web_search'), async () =>
        runtime.run({
          model: 'script:model',
          input: 'go',
          hosted_tools: [{ type: 'remote_mcp' }],
          trace_id: 'trace_hosted_opaque',
        }),
      ),
    ).rejects.toMatchObject({ code: 'unsupported_feature' });
    await expect(
      run(grants('hosted:web_search'), { tools: [{ name: 'evil' }] }),
    ).rejects.toMatchObject({ code: 'configuration_error' });
    expect(provider.turns).toHaveLength(2);
  });

  it('lets the user policy veto a hosted tool the package granted', async () => {
    const { runtime, provider } = fixture([{ output_text: 'done' }]);
    const policy = {
      check: (request: PolicyRequest) => {
        if (request.checkpoint !== 'before_hosted_tool_config') return allow();
        expect(request.metadata.tool_ref).toBe('hosted:web_search');
        expect(request.metadata.scopes).toEqual(['read']);
        return denyPolicy('user veto');
      },
    };

    const result = await permissionBoundary(grants('hosted:web_search'), async () =>
      runtime.run({
        model: 'script:model',
        input: 'go',
        hosted_tools: [webSearch],
        policy,
        trace_id: 'trace_hosted_veto',
      }),
    );

    expect(provider.turns[0]?.hosted_tools).toEqual([]);
    expect(
      result.events.some(
        (event) =>
          event.type === AgentEventTypes.TOOL_CHOICE_REJECTED && event.data.reason === 'user veto',
      ),
    ).toBe(true);
  });

  it('refuses provider-native tool search under a boundary and admits a disabled control', async () => {
    const { runtime, provider } = fixture([{ output_text: 'done' }]);
    const run = (tool_search: unknown, nested = false) =>
      permissionBoundary(grants('read'), async () =>
        runtime.run({
          model: 'script:model',
          input: 'go',
          ...(nested ? { controls: { tool_search } } : { tool_search }),
          trace_id: 'trace_tool_search',
        }),
      );

    await expect(run({ enabled: true })).rejects.toMatchObject({ code: 'unsupported_feature' });
    await expect(run({ max_results: 5 }, true)).rejects.toMatchObject({
      code: 'unsupported_feature',
    });
    expect(provider.turns).toHaveLength(0);

    const result = await run({ enabled: false });
    expect(result.output).toBe('done');
    expect(provider.turns).toHaveLength(1);
  });

  it('passes an enabled tool search through when no boundary is active', async () => {
    const { runtime, provider } = fixture([{ output_text: 'done' }]);

    await runtime.run({
      model: 'script:model',
      input: 'go',
      tool_search: { enabled: true },
      trace_id: 'trace_tool_search_inert',
    });

    expect(provider.turns[0]?.tool_search).toEqual({ enabled: true });
  });
});

describe('permission spine boundary lifetime', () => {
  it('keeps the boundary on a run stream consumed outside it', async () => {
    const { runtime, effects } = fixture([callTurn('write', 'write_1'), { output_text: 'done' }]);

    const stream = permissionBoundary(grants('read'), () =>
      runtime.stream({
        model: 'script:model',
        input: 'go',
        tools: ['read', 'write'],
        trace_id: 'trace_stream_boundary',
      }),
    );

    const events: AgentEvent[] = [];
    for await (const event of stream) {
      expect(activePermissions()).toEqual([]);
      events.push(event);
    }

    expect(effects).toEqual([]);
    expect(events.some((event) => event.type === AgentEventTypes.TOOL_CHOICE_REJECTED)).toBe(true);
    expect(activePermissions()).toEqual([]);
  });

  it('keeps the boundary inside a partially consumed run stream and closes it early', async () => {
    const { runtime, provider, effects, observed } = fixture([
      callTurn('read', 'read_1'),
      { output_text: 'done' },
    ]);

    const stream = permissionBoundary(grants('read'), () =>
      runtime.stream({
        model: 'script:model',
        input: 'go',
        tools: ['read'],
        trace_id: 'trace_stream_close',
      }),
    );
    const iterator = stream[Symbol.asyncIterator]();
    let event = await iterator.next();
    while (event.done !== true && event.value.type !== AgentEventTypes.TOOL_CALL_COMPLETED) {
      expect(activePermissions()).toEqual([]);
      event = await iterator.next();
    }
    expect(event.done).not.toBe(true);
    await iterator.return?.(undefined);

    // The handler ran on a pull made from outside the boundary and still saw
    // the one frame the stream was created inside.
    expect(observed).toEqual([1]);
    expect(effects).toEqual(['read']);
    // Closing early stopped the run before its second turn.
    expect(provider.turns).toHaveLength(1);
    expect(activePermissions()).toEqual([]);
  });

  it('keeps the boundary on a loop stream driven directly across the boundary edge', async () => {
    const { runtime, effects, observed } = fixture([
      callTurn('write', 'write_1'),
      callTurn('read', 'read_1'),
      { output_text: 'done' },
    ]);

    const stream = permissionBoundary(grants('read'), () =>
      runtime.loop.stream({
        model: 'script:model',
        input: 'go',
        tools: ['read', 'write'],
        trace_id: 'trace_loop_stream',
      }),
    );

    const events: AgentEvent[] = [];
    for await (const item of stream) {
      expect(activePermissions()).toEqual([]);
      events.push(item);
    }

    expect(observed).toEqual([1]);
    expect(effects).toEqual(['read']);
    expect(events.some((item) => item.type === AgentEventTypes.TOOL_CHOICE_REJECTED)).toBe(true);
  });

  it('keeps the boundary on an agent session stream consumed outside it', async () => {
    const seen: number[] = [];
    class BoundaryAgentProvider extends FakeAgentProvider {
      override async *streamEvents(
        session: SessionRef,
        options: { readonly after_event_id?: string } = {},
      ): AsyncIterable<AgentEvent> {
        for await (const event of super.streamEvents(session, options)) {
          seen.push(activePermissions().length);
          yield event;
        }
      }
    }
    const registry = new ProviderRegistry();
    const provider = new BoundaryAgentProvider();
    registry.registerAgentProvider(provider);
    const runtime = new AgentRuntime({ registry });
    const agent = await runtime.agents.createAgent('fake-agent', { name: 'a', model: 'm' });
    const session = await runtime.agents.start('fake-agent', agent, { input: 'go' });

    const stream = permissionBoundary(grants('read'), () => runtime.agents.stream(session));
    for await (const event of stream) {
      expect(event.session_id).toBeDefined();
      expect(activePermissions()).toEqual([]);
    }

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((length) => length === 1)).toBe(true);
  });

  it('cancels a pending approval without dispatching and leaves the next run enforceable', async () => {
    const { runtime, effects, observed } = fixture([
      callTurn('read', 'read_1'),
      callTurn('read', 'read_2'),
      { output_text: 'done' },
    ]);
    const boundary = [
      compilePackagePermissions([{ ref: 'read', approval: { mode: 'always' } }], []),
    ];
    const controller = new AbortController();
    const cancelled = new ApprovalManager();

    const first = permissionBoundary(boundary, async () =>
      runtime.run({
        model: 'script:model',
        input: 'go',
        tools: ['read'],
        approval_manager: cancelled,
        signal: controller.signal,
        trace_id: 'trace_cancelled',
      }),
    );
    await vi.waitFor(() => expect(cancelled.pending()).toHaveLength(1));
    controller.abort();

    await expect(first).rejects.toMatchObject({ code: 'run_cancelled' });
    // Nothing dispatched, so no approval key was ever granted.
    expect(effects).toEqual([]);
    expect(observed).toEqual([]);

    // A later run in the same runtime still asks for its own approval and
    // still runs inside the boundary: the cancelled run left nothing behind.
    const approvals = new ApprovalManager();
    const second = permissionBoundary(boundary, async () =>
      runtime.run({
        model: 'script:model',
        input: 'go again',
        tools: ['read'],
        approval_manager: approvals,
        trace_id: 'trace_after_cancel',
      }),
    );
    await vi.waitFor(() => expect(approvals.pending()).toHaveLength(1));
    approvals.decide(approvals.pending()[0]!.id, approve());
    await second;

    expect(effects).toEqual(['read']);
    expect(observed).toEqual([1]);
  });
});

describe('permission spine realtime dispatch', () => {
  async function realtimeFixture(policy?: { check: (request: PolicyRequest) => unknown }) {
    const effects: string[] = [];
    const provider = new FakeRealtimeProvider();
    const registry = new ProviderRegistry();
    registry.registerRealtimeProvider(provider);
    const runtime = new AgentRuntime({
      registry,
      tools: new ToolRegistry([
        {
          name: 'read',
          scopes: ['read'],
          handler: () => {
            effects.push('read');
            return 'allowed';
          },
        },
      ]),
      ...(policy === undefined ? {} : { policy: policy as never }),
    });
    return { runtime, provider, effects };
  }

  it('denies a realtime tool call under a boundary and reports the rejection', async () => {
    const { runtime, provider, effects } = await realtimeFixture();
    const session = await runtime.realtime.connect({
      model: 'fake-realtime:model',
      tools: ['read'],
      tool_mode: 'auto',
    });
    provider.queueEvent(
      session.ref,
      createAgentEvent({
        type: AgentEventTypes.TOOL_CALL_REQUESTED,
        data: { call_id: 'realtime_1', name: 'read', arguments: {} },
      }),
    );

    const events = await permissionBoundary(grants(), async () => session.collect());

    expect(effects).toEqual([]);
    expect(
      events.some(
        (event) =>
          event.type === AgentEventTypes.TOOL_CHOICE_REJECTED &&
          event.data.checkpoint === 'before_tool_call',
      ),
    ).toBe(true);
    expect(provider.commands.at(-1)).toMatchObject({
      type: 'tool_result',
      data: { call_id: 'realtime_1', is_error: true },
    });
  });

  it('threads a realtime approval through to dispatch and forgets it afterwards', async () => {
    const { runtime, provider, effects } = await realtimeFixture();
    const session = await runtime.realtime.connect({
      model: 'fake-realtime:model',
      tools: ['read'],
      tool_mode: 'auto',
    });
    for (const callId of ['realtime_2a', 'realtime_2b']) {
      provider.queueEvent(
        session.ref,
        createAgentEvent({
          type: AgentEventTypes.TOOL_CALL_REQUESTED,
          data: { call_id: callId, name: 'read', arguments: {} },
        }),
      );
    }
    const dispatchRuntime = (session as unknown as { toolRuntime: ToolRuntime }).toolRuntime;
    const before = dispatchRuntime.package_approvals;

    const collecting = permissionBoundary(
      [compilePackagePermissions([{ ref: 'read', approval: { mode: 'always' } }], [])],
      async () => session.collect(),
    );
    const approved: string[] = [];
    await vi.waitFor(() => expect(runtime.realtime.approvals.pending()).toHaveLength(1));
    approved.push(runtime.realtime.approvals.pending()[0]!.id);
    runtime.realtime.approve(approved[0]!, approve());
    // The second call of the same tool asks again: the key granted for the
    // first dispatch was removed as soon as that dispatch settled.
    await vi.waitFor(() => expect(runtime.realtime.approvals.pending()).toHaveLength(1));
    approved.push(runtime.realtime.approvals.pending()[0]!.id);
    runtime.realtime.approve(approved[1]!, approve());
    const events = await collecting;

    expect(new Set(approved).size).toBe(2);
    expect(effects).toEqual(['read', 'read']);
    expect(dispatchRuntime.package_approvals).toBe(before);
    expect(dispatchRuntime.package_approvals.size).toBe(0);
    expect(
      events.filter((event) => event.type === AgentEventTypes.TOOL_CALL_COMPLETED),
    ).toHaveLength(2);
    expect(events.some((event) => event.type === AgentEventTypes.TOOL_CHOICE_REJECTED)).toBe(false);
  });

  it('admits a plain granted realtime call with no approval at all', async () => {
    const { runtime, provider, effects } = await realtimeFixture();
    const session = await runtime.realtime.connect({
      model: 'fake-realtime:model',
      tools: ['read'],
      tool_mode: 'auto',
    });
    provider.queueEvent(
      session.ref,
      createAgentEvent({
        type: AgentEventTypes.TOOL_CALL_REQUESTED,
        data: { call_id: 'realtime_grant', name: 'read', arguments: {} },
      }),
    );

    const events = await permissionBoundary(grants('read'), async () => session.collect());

    expect(effects).toEqual(['read']);
    expect(events.some((event) => event.type === AgentEventTypes.TOOL_CALL_COMPLETED)).toBe(true);
    expect(events.some((event) => event.type === AgentEventTypes.TOOL_CHOICE_REJECTED)).toBe(false);
    expect(provider.commands.at(-1)).toMatchObject({
      type: 'tool_result',
      data: { call_id: 'realtime_grant', is_error: false },
    });
  });

  it('leaves the realtime dispatch path unchanged with no boundary', async () => {
    const { runtime, provider, effects } = await realtimeFixture();
    const session = await runtime.realtime.connect({
      model: 'fake-realtime:model',
      tools: ['read'],
      tool_mode: 'auto',
    });
    provider.queueEvent(
      session.ref,
      createAgentEvent({
        type: AgentEventTypes.TOOL_CALL_REQUESTED,
        data: { call_id: 'realtime_3', name: 'read', arguments: {} },
      }),
    );

    const events = await session.collect();

    expect(activePermissions()).toEqual([]);
    expect(effects).toEqual(['read']);
    expect(events.some((event) => event.type === AgentEventTypes.TOOL_CALL_COMPLETED)).toBe(true);
  });
});
