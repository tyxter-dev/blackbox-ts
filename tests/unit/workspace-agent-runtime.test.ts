import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AgentEventTypes,
  importPythonWorkspaceAgentPackage,
  AgentRuntime,
  ApprovalManager,
  ClaudeCodeAgentProvider,
  LocalAgentProvider,
  LocalWorkspaceProvider,
  MCPClient,
  MCPServer,
  OpenAICloudAgentProvider,
  ProviderRegistry,
  ScriptedModelProvider,
  ToolRegistry,
  VertexAIAgentEngineProvider,
  approve,
  capability,
  compilePackagePermissions,
  createRunItem,
  inProcessMCPTransport,
  mcpToolDefinitions,
  runWorkspaceAgent,
  textCompletionCapabilityProfile,
  workspaceToolDefinitions,
  type AgentCapabilities,
  type AgentEvent,
  type AgentProvider,
  type AgentSession,
  type CapabilityProfile,
  type InjectedCloudAgentClient,
  type MCPRequestContext,
  type ScriptedTurn,
  type ToolDefinition,
  type WorkspaceAgentSpec,
  type WorkspaceAgentToolPermission,
} from '../../src/index.js';
import { activePermissions, permissionBoundary } from '../../src/core/tool-permissions.js';

import pythonPackage from '../fixtures/python/workspace-agent-package.json';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function toolProfile(model?: string): CapabilityProfile {
  const base = textCompletionCapabilityProfile('script', model);
  return {
    ...base,
    summary: { ...base.summary, supports_function_tools: true },
    tools: { ...base.tools, function_tools: capability('supported') },
  };
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

/** The parent fixture: a granted `read` and an ungranted `write`. */
function setup(script: readonly ScriptedTurn[], extraTools: readonly ToolDefinition[] = []) {
  const effects: string[] = [];
  const events: AgentEvent[] = [];
  const provider = new ScriptedModelProvider(script, { id: 'script', capabilities: toolProfile });
  const registry = new ProviderRegistry();
  registry.registerModelProvider(provider);
  const tools = new ToolRegistry([
    {
      name: 'read',
      scopes: ['read'],
      handler: () => {
        effects.push('read');
        return 'allowed';
      },
    },
    {
      name: 'write',
      scopes: ['write'],
      handler: () => {
        effects.push('write');
        return 'bad';
      },
    },
    ...extraTools,
  ]);
  const runtime = new AgentRuntime({
    registry,
    tools,
    event_sink: { emit: (event) => void events.push(event) },
  });
  return { runtime, registry, provider, tools, effects, events };
}

function spec(overrides: Partial<WorkspaceAgentSpec> = {}): WorkspaceAgentSpec {
  return {
    id: 'guarded',
    name: 'guarded',
    version: '1.0.0',
    instructions: 'Be careful.',
    model: 'script:model',
    tools: ['read', 'write'],
    connectors: [],
    mcp_servers: [],
    permissions: {},
    permission_mode: 'allowlist_v1',
    grants: [{ ref: 'read' }],
    schedules: [],
    skills: [],
    visibility: 'private',
    metadata: {},
    ...overrides,
  };
}

function grantedSpec(grants: readonly WorkspaceAgentToolPermission[]): WorkspaceAgentSpec {
  return spec({ grants });
}

function toolNames(turn: { readonly tools?: readonly { readonly name: string }[] }): string[] {
  return (turn.tools ?? []).map((tool) => tool.name);
}

/** The session the local provider most recently started. */
function lastSession(local: LocalAgentProvider): AgentSession {
  const sessions = (local as unknown as { sessions: Map<string, { session: AgentSession }> })
    .sessions;
  const record = [...sessions.values()].at(-1);
  expect(record).toBeDefined();
  return record!.session;
}

/** Approve the local session's pending approval as soon as it is registered. */
async function approveLocal(
  events: readonly AgentEvent[],
  local: LocalAgentProvider,
): Promise<void> {
  await vi.waitFor(async () => {
    const event = events.find((item) => item.type === AgentEventTypes.APPROVAL_REQUESTED);
    expect(event).toBeDefined();
    const request = event!.data.request as { readonly id: string };
    await local.approve(request.id, approve());
  });
}

describe('workspace agent package runs', () => {
  it('admits a granted call end to end: compile, expose, route, approve, execute', async () => {
    const { runtime, provider, tools, effects, events } = setup([
      callTurn('search_tools', 'search_1', { query: 'read write' }),
      callTurn('load_tools', 'load_1', { names: ['read'] }),
      callTurn('read', 'read_1'),
      { output_text: 'done' },
    ]);
    const approvals = new ApprovalManager();

    const run = runWorkspaceAgent(
      runtime,
      grantedSpec([{ ref: 'read', approval: { mode: 'always' } }]),
      {
        input: 'go',
        tools: [],
        toolsets: [{ name: 'default', tools: [tools.get('read'), tools.get('write')] }],
        tool_selection: 'dynamic',
        approval_manager: approvals,
        trace_id: 'trace_bridge_admitted',
      },
    );
    await vi.waitFor(() => expect(approvals.pending()).toHaveLength(1));
    approvals.decide(approvals.pending()[0]!.id, approve());
    const result = await run;

    // Compiled grants reached exposure, routing and dispatch, and the call ran
    // only once the package's approval was recorded.
    expect(effects).toEqual(['read']);
    expect(result.output).toBe('done');
    const search = result.payloads.find((payload) => payload.tool_name === 'search_tools');
    expect(JSON.stringify(search?.payload)).not.toContain('write');
    expect(provider.turns.every((turn) => !toolNames(turn).includes('write'))).toBe(true);
    expect(events.some((event) => event.type === AgentEventTypes.TOOL_CHOICE_REJECTED)).toBe(false);
    expect(activePermissions()).toEqual([]);
  });

  it('denies an ungranted call end to end: hidden, unloadable, refused at dispatch', async () => {
    const { runtime, provider, tools, effects } = setup([
      callTurn('search_tools', 'search_1', { query: 'read write' }),
      callTurn('load_tools', 'load_1', { names: ['write'] }),
      callTurn('write', 'write_1'),
      { output_text: 'done' },
    ]);

    const result = await runWorkspaceAgent(runtime, grantedSpec([{ ref: 'read' }]), {
      input: 'go',
      tools: [],
      toolsets: [{ name: 'default', tools: [tools.get('read'), tools.get('write')] }],
      tool_selection: 'dynamic',
      trace_id: 'trace_bridge_denied',
    });

    const search = result.payloads.find((payload) => payload.tool_name === 'search_tools');
    const load = result.payloads.find((payload) => payload.tool_name === 'load_tools');
    expect(JSON.stringify(search?.payload)).not.toContain('write');
    expect(load?.payload).toMatchObject({ denied: ['write'], reason: 'denied_by_package' });
    expect(provider.turns.every((turn) => !toolNames(turn).includes('write'))).toBe(true);
    expect(effects).toEqual([]);
    expect(result.events.some((event) => event.type === AgentEventTypes.TOOL_CHOICE_REJECTED)).toBe(
      true,
    );
  });

  it('leaves an inherited package with no boundary exactly as a plain run', async () => {
    const { runtime, provider, effects } = setup([
      callTurn('write', 'write_1'),
      { output_text: 'done' },
    ]);

    const result = await runWorkspaceAgent(
      runtime,
      spec({ permission_mode: 'inherit', grants: undefined }),
      { input: 'go', trace_id: 'trace_bridge_inherit' },
    );

    expect(activePermissions()).toEqual([]);
    expect(toolNames(provider.turns[0]!)).toEqual(['read', 'write']);
    expect(effects).toEqual(['write']);
    expect(result.items.find((item) => item.type === 'function_result')?.status).toBe('completed');
  });

  it('fails an invalid package before the model is ever called', async () => {
    const { runtime, provider } = setup([{ output_text: 'done' }]);

    await expect(
      runWorkspaceAgent(runtime, grantedSpec([{ ref: 'read' }, { ref: 'read' }]), {
        input: 'go',
        trace_id: 'trace_bridge_invalid',
      }),
    ).rejects.toMatchObject({ code: 'configuration_error' });
    expect(provider.turns).toHaveLength(0);
  });
});

describe('workspace agent package workspace tools', () => {
  async function workspaceRun(allowed: boolean, prefix = 'workspace') {
    const root = await mkdtemp(join(tmpdir(), 'blackbox-package-'));
    temporaryDirectories.push(root);
    const workspace = await new LocalWorkspaceProvider().open({ kind: 'local', ref: root });
    await workspace.write('note.txt', 'original');
    const definitions = workspaceToolDefinitions(workspace).map((tool) => ({
      ...tool,
      name: tool.name.replace('workspace', prefix),
    }));
    const fixture = setup(
      [
        callTurn(`${prefix}_read`, 'read_1', { path: 'note.txt' }),
        callTurn(`${prefix}_write`, 'write_1', { path: 'note.txt', content: 'bad' }),
        { output_text: 'done' },
      ],
      definitions,
    );
    const result = await runWorkspaceAgent(
      fixture.runtime,
      spec({
        tools: definitions.map((tool) => tool.name),
        grants: allowed ? [{ ref: 'workspace:read' }] : [],
      }),
      { input: 'go', trace_id: `trace_workspace_${prefix}_${String(allowed)}` },
    );
    return { root, result };
  }

  it.each([true, false])('gates workspace operations by grant (allowed=%s)', async (allowed) => {
    const { root, result } = await workspaceRun(allowed);

    const results = result.items.filter((item) => item.type === 'function_result');
    expect(results[0]?.status).toBe(allowed ? 'completed' : 'failed');
    // The ungranted write is refused either way, so the file keeps its content.
    expect(results[1]?.status).toBe('failed');
    expect(await readFile(join(root, 'note.txt'), 'utf8')).toBe('original');
  });

  it('keeps the operation grant when the host renames the workspace tools', async () => {
    const { result } = await workspaceRun(true, 'my_workspace');

    // The grant names the operation, not the tool name -- the parent's
    // custom-workspace-prefix regression.
    expect(result.items.filter((item) => item.type === 'function_result')[0]?.status).toBe(
      'completed',
    );
  });
});

describe('workspace agent package MCP tools', () => {
  function mcpFixture(scopes?: readonly string[]) {
    const effects: string[] = [];
    const server = new MCPServer('tickets', [
      {
        name: 'lookup',
        description: 'Look a ticket up.',
        scopes,
        handler: () => {
          effects.push('mcp');
          return 'ticket-1';
        },
      },
    ]);
    const client = new MCPClient(
      { name: 'tickets', transport: 'stdio', trusted: true },
      inProcessMCPTransport(server),
    );
    return { server, client, effects };
  }

  it.each([true, false])('gates an MCP call by grant (allowed=%s)', async (allowed) => {
    const { client, effects } = mcpFixture();
    const definitions = await mcpToolDefinitions(client);
    const fixture = setup(
      [callTurn('mcp:tickets.lookup', 'mcp_1'), { output_text: 'done' }],
      definitions,
    );

    const result = await runWorkspaceAgent(
      fixture.runtime,
      spec({
        tools: ['mcp:tickets.lookup'],
        grants: allowed ? [{ ref: 'mcp:tickets.lookup', scopes: ['execute'] }] : [],
      }),
      { input: 'go', trace_id: `trace_mcp_${String(allowed)}` },
    );

    expect(effects).toEqual(allowed ? ['mcp'] : []);
    expect(result.items.find((item) => item.type === 'function_result')?.status).toBe(
      allowed ? 'completed' : 'failed',
    );
  });

  it('keeps an approved MCP dispatch granted through both call sites', async () => {
    const { client, effects } = mcpFixture(['read']);
    const definitions = await mcpToolDefinitions(client);
    const fixture = setup(
      [callTurn('mcp:tickets.lookup', 'mcp_1'), { output_text: 'done' }],
      definitions,
    );
    const approvals = new ApprovalManager();

    const run = runWorkspaceAgent(
      fixture.runtime,
      spec({
        tools: ['mcp:tickets.lookup'],
        grants: [{ ref: 'mcp:tickets.lookup', approval: { mode: 'always' } }],
      }),
      { input: 'go', approval_manager: approvals, trace_id: 'trace_mcp_approved' },
    );
    await vi.waitFor(() => expect(approvals.pending()).toHaveLength(1));
    approvals.decide(approvals.pending()[0]!.id, approve());
    const result = await run;

    // One approval carries the call through the tool runtime, the client's
    // pre-dispatch pin and the in-process server's pin without asking again.
    expect(effects).toEqual(['mcp']);
    expect(result.items.find((item) => item.type === 'function_result')?.status).toBe('completed');
  });

  it('refuses a descriptor whose scopes changed while the policy ran', async () => {
    const { server, client, effects } = mcpFixture(['read']);
    let armed = false;
    const arming = new MCPClient(
      { name: 'tickets', transport: 'stdio', trusted: true },
      inProcessMCPTransport(server),
      {
        trust: {
          evaluate: (_server, tool) => {
            if (armed && tool?.name === 'lookup') {
              armed = false;
              server.unregisterTool('lookup');
              server.registerTool({
                name: 'lookup',
                scopes: ['delete'],
                handler: () => {
                  effects.push('mcp');
                  return 'ticket-1';
                },
              });
            }
            return { allowed: true, metadata: {} };
          },
        },
      },
    );
    await arming.listTools();
    armed = true;

    await permissionBoundary(
      [compilePackagePermissions([{ ref: 'mcp:tickets.lookup' }], [])],
      async () => {
        await expect(arming.callTool('lookup', {})).rejects.toThrow('Package permission denied');
      },
    );

    expect(effects).toEqual([]);
    expect(await client.listTools()).toHaveLength(1);
  });

  it('refuses a descriptor replaced between the decision and the dispatch', async () => {
    const { server, effects } = mcpFixture(['read']);
    let armed = false;
    const client = new MCPClient(
      { name: 'tickets', transport: 'stdio', trusted: true },
      inProcessMCPTransport(server),
      {
        trust: {
          evaluate: (_server, tool) => {
            if (armed && tool?.name === 'lookup') {
              armed = false;
              // Same permission shape, a different descriptor object.
              server.unregisterTool('lookup');
              server.registerTool({
                name: 'lookup',
                scopes: ['read'],
                handler: () => {
                  effects.push('mcp');
                  return 'ticket-1';
                },
              });
            }
            return { allowed: true, metadata: {} };
          },
        },
      },
    );
    await client.listTools();
    armed = true;

    await permissionBoundary(
      [compilePackagePermissions([{ ref: 'mcp:tickets.lookup' }], [])],
      async () => {
        await expect(client.callTool('lookup', {})).rejects.toMatchObject({
          message: 'MCP tool changed during policy evaluation; retry required.',
        });
      },
    );

    expect(effects).toEqual([]);
  });

  it('cannot skip a new approval by changing the scopes after the decision', async () => {
    const { server, effects } = mcpFixture(['read']);
    let armed = false;
    const client = new MCPClient(
      { name: 'tickets', transport: 'stdio', trusted: true },
      inProcessMCPTransport(server),
      {
        trust: {
          evaluate: (_server, tool) => {
            if (armed && tool?.name === 'lookup') {
              armed = false;
              server.unregisterTool('lookup');
              server.registerTool({
                name: 'lookup',
                scopes: ['execute'],
                handler: () => {
                  effects.push('mcp');
                  return 'ticket-1';
                },
              });
            }
            return { allowed: true, metadata: {} };
          },
        },
      },
    );
    await client.listTools();
    armed = true;

    // The grant covers read and execute, but execute needs an approval this
    // call never obtained: the fresh scopes decide, not the resolved ones.
    await permissionBoundary(
      [
        compilePackagePermissions(
          [
            {
              ref: 'mcp:tickets.lookup',
              scopes: ['read', 'execute'],
              approval: { mode: 'on_execute' },
            },
          ],
          [],
        ),
      ],
      async () => {
        await expect(client.callTool('lookup', {})).rejects.toThrow('Package permission denied');
      },
    );

    expect(effects).toEqual([]);
  });

  it('calls an ungranted MCP tool untouched when no boundary is active', async () => {
    const { client, effects } = mcpFixture();

    const result = await client.callTool('lookup', {});

    expect(effects).toEqual(['mcp']);
    expect(result.content[0]).toMatchObject({ type: 'text', text: 'ticket-1' });
    expect(activePermissions()).toEqual([]);
  });

  /** A transport that counts `tools/list` round trips. */
  function countingTransport(server: MCPServer) {
    const transport = inProcessMCPTransport(server);
    const counter = { lists: 0 };
    return {
      counter,
      transport: {
        request: (method: string, params: unknown, context: MCPRequestContext) => {
          if (method === 'tools/list') counter.lists += 1;
          return transport.request(method, params, context);
        },
        onNotification: transport.onNotification,
      },
    };
  }

  it('runs two concurrent granted calls on a cold cache without a spurious pin', async () => {
    const { server, effects } = mcpFixture(['read']);
    const { counter, transport } = countingTransport(server);
    const client = new MCPClient({ name: 'tickets', transport: 'stdio', trusted: true }, transport);
    await client.initialize();

    const results = await permissionBoundary(
      [compilePackagePermissions([{ ref: 'mcp:tickets.lookup' }], [])],
      () => Promise.all([client.callTool('lookup', {}), client.callTool('lookup', {})]),
    );

    // Both callers joined one discovery and pinned the same descriptor
    // object; nothing changed, so nothing was refused.
    expect(counter.lists).toBe(1);
    expect(effects).toEqual(['mcp', 'mcp']);
    expect(results.map((result) => result.content[0])).toEqual([
      { type: 'text', text: 'ticket-1' },
      { type: 'text', text: 'ticket-1' },
    ]);
  });

  it('does not refuse an unchanged tool when the cache TTL lapses during the trust step', async () => {
    const { server, effects } = mcpFixture(['read']);
    const { counter, transport } = countingTransport(server);
    let now = 0;
    let armed = false;
    const client = new MCPClient(
      { name: 'tickets', transport: 'stdio', trusted: true },
      transport,
      {
        now: () => now,
        cache_ttl_ms: 1_000,
        trust: {
          evaluate: (_server, tool) => {
            // The per-call trust step outlives the cache TTL.
            if (armed && tool?.name === 'lookup') now += 2_000;
            return { allowed: true, metadata: {} };
          },
        },
      },
    );
    const [resolved] = await client.listTools();
    armed = true;

    await permissionBoundary(
      [compilePackagePermissions([{ ref: 'mcp:tickets.lookup' }], [])],
      async () => {
        await expect(client.callTool('lookup', {})).resolves.toMatchObject({
          content: [{ type: 'text', text: 'ticket-1' }],
        });
      },
    );

    // The pin decided against the registry this call resolved from -- a timer
    // is not a change -- and a later refresh that finds the same list keeps
    // the same descriptor object, while a real change does not.
    expect(effects).toEqual(['mcp']);
    expect(counter.lists).toBe(1);
    const [refreshed] = await client.listTools();
    expect(counter.lists).toBe(2);
    expect(refreshed).toBe(resolved);
    server.registerTool({ name: 'other', handler: () => 'other' });
    const [changed] = await client.listTools();
    expect(changed).not.toBe(resolved);
  });
});

describe('workspace agent package provider surfaces', () => {
  function localFixture(script: readonly ScriptedTurn[]) {
    const fixture = setup(script);
    const local = new LocalAgentProvider(fixture.runtime);
    fixture.registry.registerAgentProvider(local);
    return { ...fixture, local };
  }

  it('runs a package on the local agent provider and denies the ungranted call', async () => {
    const { runtime, local, effects } = localFixture([
      callTurn('write', 'write_1'),
      callTurn('read', 'read_1'),
      { output_text: 'done' },
    ]);

    const result = await runWorkspaceAgent(runtime, grantedSpec([{ ref: 'read' }]), {
      input: 'go',
      agent_provider: 'local',
      trace_id: 'trace_local_walkthrough',
    });

    expect(effects).toEqual(['read']);
    expect(result.status).toBe('completed');
    expect(local.capabilities().supports_package_permissions).toBe(true);
    expect(activePermissions()).toEqual([]);
  });

  it('honours model and instructions overrides on the agent-provider path', async () => {
    const { runtime, provider, local } = localFixture([
      { output_text: 'done' },
      { output_text: 'done' },
    ]);

    await runWorkspaceAgent(runtime, grantedSpec([{ ref: 'read' }]), {
      input: 'go',
      agent_provider: 'local',
      model: 'script:other',
      instructions: 'Override.',
      trace_id: 'trace_local_override',
    });
    // The adapter reads the effective values off the AgentSpec it was handed.
    expect(lastSession(local).model).toBe('script:other');
    expect(provider.turns[0]).toMatchObject({ instructions: 'Override.' });
    expect(provider.turns[0]?.model).toMatch(/other/);

    await runWorkspaceAgent(runtime, grantedSpec([{ ref: 'read' }]), {
      input: 'go',
      agent_provider: 'local',
      trace_id: 'trace_local_package_values',
    });
    // With no override the package's own values travel, exactly as on the
    // model path.
    expect(lastSession(local).model).toBe('script:model');
    expect(provider.turns[1]).toMatchObject({ instructions: 'Be careful.' });
    expect(provider.turns[1]?.model).toMatch(/model/);
  });

  /** A grant that admits the `read` tool only (grants default to the read scope). */
  const READ_ONLY: readonly WorkspaceAgentToolPermission[] = [{ ref: 'read' }];
  /** Grants that admit both the `read` and the write-scoped `write` tool. */
  const READ_WRITE: readonly WorkspaceAgentToolPermission[] = [
    { ref: 'read' },
    { ref: 'write', scopes: ['write'] },
  ];

  /** An agent and session created inside `grants`, with the first turn drained. */
  async function sessionUnder(
    local: LocalAgentProvider,
    grants: readonly WorkspaceAgentToolPermission[],
  ) {
    const permissions = [compilePackagePermissions(grants, [])];
    const session = await permissionBoundary(permissions, async () => {
      const agent = await local.createAgent({
        name: 'guarded',
        model: 'script:model',
        metadata: { run_request: { tools: ['read', 'write'] } },
      });
      return local.startSession(agent, { input: 'go' });
    });
    await local.resume(session);
    return session;
  }

  it('never widens a narrower ambient boundary with the session snapshot', async () => {
    const { local, effects, events } = localFixture([
      { output_text: 'ready' },
      callTurn('write', 'write_1'),
      { output_text: 'refused' },
      callTurn('write', 'write_2'),
      { output_text: 'done' },
    ]);
    // The snapshot grants read and write; the boundary the follow-up is sent
    // from grants only read, and both frames decide.
    const session = await sessionUnder(local, READ_WRITE);

    await permissionBoundary([compilePackagePermissions(READ_ONLY, [])], async () => {
      await local.sendMessage(session, 'write now');
      await local.resume(session);
    });
    expect(effects).toEqual([]);
    expect(
      events.filter((event) => event.type === AgentEventTypes.TOOL_CHOICE_REJECTED),
    ).toHaveLength(1);

    // Control: the same follow-up from inside the boundary the session was
    // created in is admitted, so it was the narrower frame that denied.
    await permissionBoundary([compilePackagePermissions(READ_WRITE, [])], async () => {
      await local.sendMessage(session, 'write again');
      await local.resume(session);
    });
    expect(effects).toEqual(['write']);
    expect(activePermissions()).toEqual([]);
  });

  it('keeps the session snapshot under a wider or absent ambient boundary', async () => {
    const { local, effects, events } = localFixture([
      { output_text: 'ready' },
      callTurn('write', 'write_1'),
      { output_text: 'refused' },
      callTurn('write', 'write_2'),
      { output_text: 'refused again' },
    ]);
    const session = await sessionUnder(local, READ_ONLY);

    // A wider ambient boundary cannot lift the stored read-only snapshot ...
    await permissionBoundary([compilePackagePermissions(READ_WRITE, [])], async () => {
      await local.sendMessage(session, 'write now');
      await local.resume(session);
    });
    // ... and neither can sending the follow-up from no boundary at all.
    await local.sendMessage(session, 'write again');
    await local.resume(session);

    expect(effects).toEqual([]);
    expect(
      events.filter((event) => event.type === AgentEventTypes.TOOL_CHOICE_REJECTED),
    ).toHaveLength(2);
    expect(activePermissions()).toEqual([]);
  });

  it('keeps the session boundary on a follow-up consumed outside it', async () => {
    const { runtime, local, effects } = localFixture([
      { output_text: 'ready' },
      callTurn('write', 'write_2'),
      { output_text: 'safe' },
    ]);
    await runWorkspaceAgent(runtime, grantedSpec([{ ref: 'read' }]), {
      input: 'go',
      agent_provider: 'local',
      trace_id: 'trace_local_followup',
    });
    const session = lastSession(local);

    await local.sendMessage(session, 'write now');
    const streamed: AgentEvent[] = [];
    for await (const event of local.streamEvents(session)) {
      // The consumer drives the generator from outside the boundary and never
      // inherits it, while the session's own steps stay constrained.
      expect(activePermissions()).toEqual([]);
      streamed.push(event);
    }

    expect(effects).toEqual([]);
    expect(streamed.some((event) => event.type === AgentEventTypes.TOOL_CHOICE_REJECTED)).toBe(
      true,
    );
    expect(activePermissions()).toEqual([]);
  });

  it('closes a partially consumed session stream without leaking the boundary', async () => {
    const { runtime, local, effects, events } = localFixture([
      callTurn('read', 'read_1'),
      { output_text: 'done' },
    ]);

    const run = runWorkspaceAgent(
      runtime,
      grantedSpec([{ ref: 'read', approval: { mode: 'always' } }]),
      { input: 'go', agent_provider: 'local', trace_id: 'trace_local_close' },
    );
    await approveLocal(events, local);
    await run;
    expect(effects).toEqual(['read']);

    const session = lastSession(local);
    const iterator = local.streamEvents(session)[Symbol.asyncIterator]();
    await iterator.next();
    expect(activePermissions()).toEqual([]);
    await iterator.return?.(undefined);
    expect(activePermissions()).toEqual([]);
  });

  it('drops the boundary when a package session is cancelled mid-approval', async () => {
    // Provider level: the facade's own stream cannot be consumed across a
    // cancellation (a pre-existing terminal-transition defect, unrelated to
    // permissions), so the session is driven through the provider here.
    const { local, effects, events } = localFixture([
      callTurn('read', 'read_1'),
      { output_text: 'done' },
    ]);
    const permissions = [
      compilePackagePermissions([{ ref: 'read', approval: { mode: 'always' } }], []),
    ];

    const session = await permissionBoundary(permissions, async () => {
      const agent = await local.createAgent({
        name: 'guarded',
        model: 'script:model',
        metadata: { run_request: { tools: ['read', 'write'] } },
      });
      return local.startSession(agent, { input: 'go' });
    });
    await vi.waitFor(() =>
      expect(events.some((event) => event.type === AgentEventTypes.APPROVAL_REQUESTED)).toBe(true),
    );
    await local.cancel(session);
    await local.resume(session);

    expect(effects).toEqual([]);
    expect(activePermissions()).toEqual([]);
  });

  it('refuses a package on an adapter that cannot enforce it, before any startup', async () => {
    const started: string[] = [];
    const managed: AgentProvider = {
      id: 'managed',
      capabilities: (): AgentCapabilities => ({
        supports_streaming_events: true,
        supports_resume: false,
        supports_follow_up: false,
        supports_cancellation: false,
        supports_artifacts: false,
        supports_approvals: false,
        metadata: {},
      }),
      createAgent: async () => {
        started.push('create');
        throw new Error('startup happened');
      },
      startSession: async () => {
        started.push('start');
        throw new Error('startup happened');
      },
      streamEvents: () => {
        throw new Error('startup happened');
      },
      sendMessage: async () => {
        throw new Error('startup happened');
      },
      approve: async () => undefined,
      cancel: async () => undefined,
      listArtifacts: async () => {
        throw new Error('startup happened');
      },
    };
    const { runtime, registry } = setup([{ output_text: 'done' }]);
    registry.registerAgentProvider(managed);

    await expect(
      runWorkspaceAgent(runtime, grantedSpec([{ ref: 'read' }]), {
        input: 'go',
        agent_provider: 'managed',
        trace_id: 'trace_managed',
      }),
    ).rejects.toMatchObject({ code: 'unsupported_feature' });
    // An inherited package inside an ambient boundary is refused identically.
    await permissionBoundary([compilePackagePermissions([], [])], async () => {
      await expect(
        runWorkspaceAgent(runtime, spec({ permission_mode: 'inherit', grants: undefined }), {
          input: 'go',
          agent_provider: 'managed',
          trace_id: 'trace_managed_inherit',
        }),
      ).rejects.toMatchObject({ code: 'unsupported_feature' });
    });
    expect(started).toEqual([]);
  });

  it('leaves a non-enforcing adapter reachable when no boundary is active', async () => {
    const { runtime, registry } = setup([{ output_text: 'done' }]);
    const vertex = new VertexAIAgentEngineProvider();
    registry.registerAgentProvider(vertex);

    expect(vertex.capabilities().supports_package_permissions).toBe(false);
    expect(activePermissions()).toEqual([]);
    // The stub's own refusal, not the package gate: the adapter was reached.
    await expect(runtime.agents.createAgent('vertex-agent-engine', { name: 'v' })).rejects.toThrow(
      'Vertex AI Agent Engine',
    );
  });

  it('does not let an injected cloud client advertise package enforcement', () => {
    const client = {
      capabilities: () => ({ supports_package_permissions: true }),
      createAgent: async () => ({ provider: 'x', id: 'a', metadata: {} }),
      startSession: async () => {
        throw new Error('unused');
      },
      streamEvents: () => {
        throw new Error('unused');
      },
      sendMessage: async () => {
        throw new Error('unused');
      },
      approve: async () => undefined,
      cancel: async () => undefined,
      listArtifacts: async () => {
        throw new Error('unused');
      },
    } as unknown as InjectedCloudAgentClient;

    expect(new OpenAICloudAgentProvider(client).capabilities().supports_package_permissions).toBe(
      false,
    );
    expect(new ClaudeCodeAgentProvider(client).capabilities().supports_package_permissions).toBe(
      false,
    );
  });
});

describe('imported Python packages through native runtime consumers', () => {
  const options = { connector_auth: { files: 'host-managed' } };
  it.each(['local', 'model'] as const)(
    'enforces imported grants and caller overrides through %s',
    async (route) => {
      const imported = importPythonWorkspaceAgentPackage(
        Buffer.from(pythonPackage.archive_base64, 'base64'),
        options,
      );
      const root = await mkdtemp(join(tmpdir(), 'blackbox-python-package-'));
      temporaryDirectories.push(root);
      const workspace = await new LocalWorkspaceProvider().open({ kind: 'local', ref: root });
      await workspace.write('note.txt', 'original');
      const fixture = setup(
        [
          callTurn('workspace_read', 'read', { path: 'note.txt' }),
          callTurn('workspace_write', 'write', { path: 'note.txt', content: 'bad' }),
          { output_text: 'done' },
        ],
        workspaceToolDefinitions(workspace),
      );
      fixture.registry.registerAgentProvider(new LocalAgentProvider(fixture.runtime));
      const result = await runWorkspaceAgent(fixture.runtime, imported.spec, {
        ...imported.run_options,
        agent_provider: route === 'local' ? 'local' : undefined,
        input: 'go',
        model: 'script:override',
        instructions: 'Override instructions.',
        tools: ['workspace_read', 'workspace_write'],
      });
      expect(result.output).toBe('done');
      expect(fixture.provider.turns[0]).toMatchObject({
        model: 'override',
        instructions: 'Override instructions.',
      });
      const outcomes = fixture.events.filter((event) =>
        [AgentEventTypes.TOOL_CALL_COMPLETED, AgentEventTypes.TOOL_CALL_FAILED].includes(
          event.type,
        ),
      );
      expect(outcomes.map((event) => event.type)).toEqual([
        AgentEventTypes.TOOL_CALL_COMPLETED,
        AgentEventTypes.TOOL_CALL_FAILED,
      ]);
      expect(outcomes.map((event) => event.data.name)).toEqual([
        'workspace_read',
        'workspace_write',
      ]);
      expect(await readFile(join(root, 'note.txt'), 'utf8')).toBe('original');
      expect(toolNames(fixture.provider.turns[0]!)).toContain('workspace_read');
      expect(toolNames(fixture.provider.turns[0]!)).not.toContain('workspace_write');

      const rejected = runWorkspaceAgent(fixture.runtime, imported.spec, {
        ...imported.run_options,
        agent_provider: route === 'local' ? 'local' : undefined,
        input: 'go',
        extra: { opaque_option: true },
      });
      if (route === 'local') expect(await rejected).toMatchObject({ status: 'failed' });
      else await expect(rejected).rejects.toThrow(/allowlist_v1/);
      expect(fixture.provider.turns).toHaveLength(3);
    },
  );

  it.each(['local', 'model'] as const)(
    'delivers explicit hosted/extra options to the %s model consumer',
    async (route) => {
      const bytes =
        route === 'local'
          ? pythonPackage.local_options_archive
          : pythonPackage.model_options_archive;
      const imported = importPythonWorkspaceAgentPackage(Buffer.from(bytes, 'base64'), options);
      const base = toolProfile();
      const provider = new ScriptedModelProvider([{ output_text: 'configured' }], {
        id: 'script',
        capabilities: () => ({
          ...base,
          hosted_tools: { web_search: capability('supported') },
          controls: { ...base.controls, extra: capability('supported') },
        }),
      });
      const registry = new ProviderRegistry();
      registry.registerModelProvider(provider);
      const runtime = new AgentRuntime({ registry });
      registry.registerAgentProvider(new LocalAgentProvider(runtime));
      const result = await runWorkspaceAgent(runtime, imported.spec, {
        ...imported.run_options,
        input: 'go',
        tools: [],
      });
      expect(result.output).toBe('configured');
      expect(provider.turns[0]).toMatchObject({
        model: 'model',
        hosted_tools: [{ type: 'web_search', config: { depth: 'short' } }],
        extra: { fixture_option: 'present' },
      });
    },
  );
});
