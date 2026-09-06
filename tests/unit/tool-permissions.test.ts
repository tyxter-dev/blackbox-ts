import { describe, expect, it } from 'vitest';

import {
  AgentRuntime,
  ProviderRegistry,
  ScriptedModelProvider,
  ToolRegistry,
  ToolRuntime,
  ToolsetRuntime,
  capability,
  compilePackagePermissions,
  createRunItem,
  structuredOutput,
  textCompletionCapabilityProfile,
  toAgentSpec,
  toolPermissionPolicyRequest,
  type CapabilityProfile,
  type HostedToolSpec,
  type ToolDefinition,
  type ToolHandler,
  type WorkspaceAgentConnector,
  type WorkspaceAgentToolPermission,
} from '../../src/index.js';
import {
  activePermissions,
  approvalKey,
  canonicalRef,
  packageCallApproved,
  packageDecision,
  permissionBoundary,
  permissionBoundaryIterator,
  toolRequest,
  validatePackageModelConfig,
} from '../../src/core/tool-permissions.js';

function toolProfile(model?: string): CapabilityProfile {
  const base = textCompletionCapabilityProfile('script', model);
  return {
    ...base,
    summary: { ...base.summary, supports_function_tools: true },
    tools: { ...base.tools, function_tools: capability('supported') },
    output: { ...base.output, finalizer_tool: capability('supported') },
  };
}

/** Two tools mirroring the parent fixture: a granted read and an ungranted write. */
function fixtureTools(): { registry: ToolRegistry; effects: string[] } {
  const effects: string[] = [];
  const registry = new ToolRegistry([
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
  ]);
  return { registry, effects };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe('package permission compilation', () => {
  it.each([
    ['duplicate canonical ref', [{ ref: 'a' }, { ref: 'local:a' }], []],
    [
      'duplicate connector',
      [],
      [
        { name: 'x', type: 'test', auth: 'none' },
        { name: 'x', type: 'test', auth: 'none' },
      ],
    ],
    ['invalid approval mode', [{ ref: 'a', approval: { mode: 'invalid' } }], []],
    ['unknown connector', [{ ref: 'a', connector: 'missing' }], []],
    [
      'connector does not bind the ref',
      [{ ref: 'a', connector: 'x' }],
      [{ name: 'x', type: 'test', auth: 'none', tool_refs: ['b'] }],
    ],
    ['unknown scope', [{ ref: 'a', scopes: ['sudo'] }], []],
  ] as [string, WorkspaceAgentToolPermission[], WorkspaceAgentConnector[]][])(
    'fails closed on %s',
    (_label, permissions, connectors) => {
      expect(() => compilePackagePermissions(permissions, connectors)).toThrowError(
        expect.objectContaining({ code: 'configuration_error' }),
      );
    },
  );

  it('treats the compiled snapshot and connector scopes as authoritative', async () => {
    const effects: string[] = [];
    const registry = new ToolRegistry([
      {
        name: 'lookup',
        scopes: ['read'],
        metadata: { connector: 'crm', connector_scopes: ['tickets.read'], ref: 'local:evil' },
        handler: () => {
          effects.push('yes');
          return 'ok';
        },
      },
    ]);
    const definition = registry.get('lookup');
    const permissionScopes = ['read'];
    const connectorScopes = ['tickets.read'];
    const permission: WorkspaceAgentToolPermission = {
      ref: 'lookup',
      connector: 'crm',
      scopes: permissionScopes,
      metadata: { connector: 'wrong', scopes: ['admin'] },
    };
    const connector: WorkspaceAgentConnector = {
      name: 'crm',
      type: 'test',
      auth: 'api_key',
      scopes: connectorScopes,
      tool_refs: ['lookup'],
    };
    const boundary = compilePackagePermissions([permission], [connector]);
    permissionScopes.length = 0;
    connectorScopes.length = 0;

    await permissionBoundary([boundary], async () => {
      expect((await new ToolRuntime(registry).call('lookup', {})).is_error).toBe(false);
      const mutable = definition.metadata as Record<string, unknown>;
      mutable.connector_scopes = ['tickets.delete'];
      expect((await new ToolRuntime(registry).call('lookup', {})).is_error).toBe(true);
    });

    expect(effects).toEqual(['yes']);
    const request = toolPermissionPolicyRequest(permission, {
      agent_id: 'a',
      checkpoint: 'before_tool_call',
    });
    expect(request.metadata.connector).toBe('crm');
    expect(request.metadata.scopes).toEqual([]);
    expect(toolRequest(definition).metadata.tool_ref).toBe('local:lookup');
  });

  it('falls back to the execute scope and preserves descriptor metadata', () => {
    const registry = new ToolRegistry([
      { name: 'unknown', latency: 'slow', cost: 'high', handler: () => undefined },
      { name: 'mcp:server.lookup', handler: () => undefined },
      {
        name: 'workspace_read_file',
        category: 'workspace',
        scopes: ['read'],
        handler: () => undefined,
      },
    ]);
    const request = toolRequest(registry.get('unknown'));
    expect(request.metadata.scopes).toEqual([]);
    expect(request.metadata.permission_scopes).toEqual(['execute']);
    expect(request.metadata.latency).toBe('slow');
    expect(request.metadata.cost).toBe('high');

    const mcp = toolRequest(registry.get('mcp:server.lookup'));
    expect(mcp.metadata.tool_ref).toBe('mcp:server.lookup');
    expect(mcp.metadata.server).toBe('server');
    expect(mcp.metadata.tool).toBe('lookup');
    expect(toolRequest(registry.get('workspace_read_file')).metadata.tool_ref).toBe(
      'workspace:read_file',
    );
    expect(canonicalRef('hosted:bash')).toBe('hosted:shell');
    expect(canonicalRef('hosted:computer_use')).toBe('hosted:computer');

    expect(compilePackagePermissions([{ ref: 'unknown' }], []).decide(request).verdict).toBe(
      'deny',
    );
    expect(
      compilePackagePermissions([{ ref: 'unknown', scopes: ['execute'] }], []).decide(request)
        .verdict,
    ).toBe('allow');
    expect(
      compilePackagePermissions([], []).decide({
        checkpoint: 'before_tool_call',
        action: 'unknown',
        arguments: {},
        metadata: {},
      }).verdict,
    ).toBe('deny');
  });

  it('skips approval at exposure and composes nested boundary frames', async () => {
    const registry = new ToolRegistry([{ name: 'read', scopes: ['read'], handler: () => 'ok' }]);
    const request = toolRequest(registry.get('read'), { checkpoint: 'before_tool_call' });
    const exposure = toolRequest(registry.get('read'));
    const approving = compilePackagePermissions(
      [{ ref: 'read', approval: { mode: 'always', reason: 'human review' } }],
      [],
    );
    const permissive = compilePackagePermissions([{ ref: 'read' }], []);
    const denying = compilePackagePermissions([], []);

    expect(approving.decide(request)).toMatchObject({
      verdict: 'require_approval',
      reason: 'human review',
    });
    expect(approving.decide(exposure).verdict).toBe('allow');
    expect(approving.decide(request, { approvals: false }).verdict).toBe('allow');

    await permissionBoundary([permissive, approving], async () => {
      expect(packageDecision(request).verdict).toBe('require_approval');
    });
    await permissionBoundary([approving, denying], async () => {
      expect(packageDecision(request).verdict).toBe('deny');
    });
    expect(activePermissions()).toEqual([]);
  });
});

describe('package permission dispatch enforcement', () => {
  it('denies a dispatch under deny-all and admits the same dispatch under a matching grant', async () => {
    const { registry, effects } = fixtureTools();
    const runtime = new ToolRuntime(registry);

    const denied = await permissionBoundary([compilePackagePermissions([], [])], async () =>
      runtime.call('read', {}),
    );
    expect(denied.is_error).toBe(true);
    expect(denied.metadata.error).toBe('denied_by_policy');
    expect(denied.payload).toMatchObject({ error: 'denied_by_policy' });
    expect(effects).toEqual([]);

    const admitted = await permissionBoundary(
      [compilePackagePermissions([{ ref: 'read' }], [])],
      async () => runtime.call('read', {}),
    );
    expect(admitted.is_error).toBe(false);
    expect(effects).toEqual(['read']);
  });

  it('denies a wrong scope and a wrong connector binding at dispatch', async () => {
    const { registry, effects } = fixtureTools();
    const connectors: WorkspaceAgentConnector[] = [
      { name: 'crm', type: 'test', auth: 'none', tool_refs: ['read'] },
    ];
    for (const permissions of [
      [{ ref: 'read', scopes: ['write'] }],
      [{ ref: 'read', connector: 'crm' }],
    ] as WorkspaceAgentToolPermission[][]) {
      const result = await permissionBoundary(
        [compilePackagePermissions(permissions, connectors)],
        async () => new ToolRuntime(registry).call('read', {}),
      );
      expect(result.metadata.error).toBe('denied_by_policy');
    }
    expect(effects).toEqual([]);
  });

  it('requires approval before dispatch and completes once the key is granted', async () => {
    const { registry, effects } = fixtureTools();
    const boundary = compilePackagePermissions(
      [{ ref: 'read', approval: { mode: 'always', reason: 'ask first' } }],
      [],
    );
    const runtime = new ToolRuntime(registry);

    const pending = await permissionBoundary([boundary], async () => runtime.call('read', {}));
    expect(pending.metadata).toMatchObject({ error: 'denied_by_policy', reason: 'ask first' });
    expect(effects).toEqual([]);

    runtime.package_approvals = new Set([approvalKey(registry.get('read'))]);
    const approved = await permissionBoundary([boundary], async () => runtime.call('read', {}));
    expect(approved.is_error).toBe(false);
    expect(effects).toEqual(['read']);
  });

  it('publishes the approved request to the handler for nested checkpoints', async () => {
    const seen: boolean[] = [];
    const registry = new ToolRegistry([
      {
        name: 'read',
        scopes: ['read'],
        handler: () => {
          seen.push(packageCallApproved(toolRequest(registry.get('read'))));
          return 'ok';
        },
      },
    ]);
    const boundary = compilePackagePermissions([{ ref: 'read', approval: { mode: 'always' } }], []);
    const runtime = new ToolRuntime(registry, {
      package_approvals: new Set([approvalKey(registry.get('read'))]),
    });

    await permissionBoundary([boundary], async () => runtime.call('read', {}));
    await permissionBoundary([compilePackagePermissions([{ ref: 'read' }], [])], async () =>
      new ToolRuntime(registry).call('read', {}),
    );
    expect(seen).toEqual([true, false]);
  });

  it('refuses a non-array scopes claim instead of falling back to execute', () => {
    const grant = compilePackagePermissions([{ ref: 'shady', scopes: ['execute'] }], []);
    const scoped = (permission_scopes: unknown) =>
      grant.decide({
        checkpoint: 'before_tool_call',
        action: 'shady',
        arguments: {},
        metadata: { permission_scopes },
      }).verdict;

    expect(scoped(['execute'])).toBe('allow');
    expect(scoped(undefined)).toBe('allow');
    expect(scoped([])).toBe('allow');
    expect(scoped('admin')).toBe('deny');
    expect(scoped({ execute: true })).toBe('deny');
  });

  it('invalidates a granted approval when the callable or its metadata changes', async () => {
    const effects: string[] = [];
    const registry = new ToolRegistry([
      {
        name: 'read',
        scopes: ['read'],
        metadata: {},
        handler: () => {
          effects.push('original');
          return 'ok';
        },
      },
    ]);
    const registered = registry.get('read') as {
      handler?: ToolHandler;
      metadata?: Record<string, unknown>;
    };
    const originalHandler = registered.handler as ToolHandler;
    const boundary = [
      compilePackagePermissions([{ ref: 'read', approval: { mode: 'always' } }], []),
    ];
    const runtime = new ToolRuntime(registry, {
      package_approvals: new Set([approvalKey(registry.get('read'))]),
    });
    const dispatch = async () => permissionBoundary(boundary, async () => runtime.call('read', {}));

    expect((await dispatch()).is_error).toBe(false);
    expect(effects).toEqual(['original']);

    registered.handler = () => {
      effects.push('replaced');
      return 'bad';
    };
    expect((await dispatch()).metadata.error).toBe('denied_by_policy');

    registered.handler = originalHandler;
    expect((await dispatch()).is_error).toBe(false);

    // A benign metadata edit leaves the grant matching, so only the stale
    // approval key can explain this denial.
    registered.metadata = { note: 'edited' };
    expect((await dispatch()).metadata.error).toBe('denied_by_policy');
    runtime.package_approvals = new Set([approvalKey(registry.get('read'))]);
    expect((await dispatch()).is_error).toBe(false);
    expect(effects).toEqual(['original', 'original', 'original']);
  });

  it('pins the checked definition for the whole dispatch', async () => {
    const effects: string[] = [];
    const gate = deferred();
    const registry = new ToolRegistry([
      {
        name: 'read',
        scopes: ['read'],
        handler: async () => {
          await gate.promise;
          effects.push('original');
          return 'ok';
        },
      },
    ]);
    const registered = registry.get('read') as {
      handler?: ToolHandler;
      metadata?: Record<string, unknown>;
    };

    const result = await permissionBoundary(
      [compilePackagePermissions([{ ref: 'read' }], [])],
      async () => {
        const pending = new ToolRuntime(registry).call('read', {});
        await new Promise((resolve) => setTimeout(resolve, 0));
        registered.handler = () => {
          effects.push('replaced');
          return 'bad';
        };
        registered.metadata = { connector: 'crm' };
        gate.resolve();
        return pending;
      },
    );

    expect(result.is_error).toBe(false);
    expect(effects).toEqual(['original']);
  });

  it('isolates concurrent boundaries across interleaved async chains', async () => {
    const { registry, effects } = fixtureTools();
    const barrier = deferred();

    const restricted = permissionBoundary([compilePackagePermissions([], [])], async () => {
      barrier.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      return new ToolRuntime(registry).call('read', {});
    });
    const unrestricted = (async () => {
      await barrier.promise;
      return new ToolRuntime(registry).call('write', {});
    })();

    const [denied, allowed] = await Promise.all([restricted, unrestricted]);
    expect(denied.metadata.error).toBe('denied_by_policy');
    expect(allowed.is_error).toBe(false);
    expect(effects).toEqual(['write']);
    expect(activePermissions()).toEqual([]);
  });

  it('keeps the boundary across consumer-driven generator suspension', async () => {
    const { registry, effects } = fixtureTools();
    const boundary = [compilePackagePermissions([], [])];

    async function* dispatchTwice(): AsyncGenerator<string> {
      const first = await new ToolRuntime(registry).call('read', {});
      yield String(first.metadata.error);
      const second = await new ToolRuntime(registry).call('read', {});
      yield String(second.metadata.error);
    }

    const source = permissionBoundary(boundary, () => dispatchTwice());
    const guarded = permissionBoundaryIterator(boundary, source);
    const seen: string[] = [];
    for await (const value of guarded) seen.push(value);

    expect(seen).toEqual(['denied_by_policy', 'denied_by_policy']);
    expect(effects).toEqual([]);
    expect(activePermissions()).toEqual([]);
  });

  it('closes a partially consumed generator inside the boundary', async () => {
    const { registry, effects } = fixtureTools();
    const boundary = [compilePackagePermissions([], [])];
    let closedInside: readonly unknown[] | undefined;

    async function* dispatchTwice(): AsyncGenerator<string> {
      try {
        const first = await new ToolRuntime(registry).call('read', {});
        yield String(first.metadata.error);
        yield 'unreachable';
      } finally {
        closedInside = activePermissions();
      }
    }

    const guarded = permissionBoundaryIterator(
      boundary,
      permissionBoundary(boundary, () => dispatchTwice()),
    );
    expect((await guarded.next()).value).toBe('denied_by_policy');
    await guarded.return(undefined);

    expect(closedInside).toEqual(boundary);
    expect(effects).toEqual([]);
    expect(activePermissions()).toEqual([]);
  });
});

describe('package permission negative space', () => {
  it('leaves dispatch unchanged when no boundary is active', async () => {
    const { registry, effects } = fixtureTools();
    expect(activePermissions()).toEqual([]);
    const result = await new ToolRuntime(registry).call('write', {});
    expect(result.is_error).toBe(false);
    expect(effects).toEqual(['write']);
    expect((await new ToolRuntime(registry).call('read', {}, { mock: true })).metadata.mock).toBe(
      true,
    );
  });

  it('builds no policy request on the inert path', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'untouched',
      scopes: ['read'],
      // Reading metadata is exactly what the permission machinery does; a
      // throwing getter proves the inert dispatch never looks.
      get metadata(): Readonly<Record<string, unknown>> {
        throw new Error('metadata must not be read without a boundary.');
      },
      handler: () => 'ok',
    });
    const runtime = new ToolRuntime(registry);

    expect(activePermissions()).toEqual([]);
    expect(runtime.package_approvals.size).toBe(0);
    await expect(runtime.call('untouched', {})).resolves.toMatchObject({ is_error: false });
  });

  it('enforces a definition whose fields live on its prototype', async () => {
    const effects: string[] = [];
    class PrototypeTool {
      readonly name = 'classy';
      readonly scopes = ['read'];
      get handler(): ToolHandler {
        return () => {
          effects.push('classy');
          return 'ok';
        };
      }
    }
    const registry = new ToolRegistry([new PrototypeTool()]);
    const runtime = new ToolRuntime(registry);

    // Prototype accessors survived dispatch before package permissions existed.
    expect((await runtime.call('classy', {})).is_error).toBe(false);
    expect(
      (
        await permissionBoundary([compilePackagePermissions([], [])], async () =>
          runtime.call('classy', {}),
        )
      ).metadata.error,
    ).toBe('denied_by_policy');
    expect(
      (
        await permissionBoundary([compilePackagePermissions([{ ref: 'classy' }], [])], async () =>
          runtime.call('classy', {}),
        )
      ).is_error,
    ).toBe(false);
    expect(effects).toEqual(['classy', 'classy']);
  });

  it('denies a mocked dispatch before the mock short-circuit', async () => {
    const { registry, effects } = fixtureTools();
    const mocked = await permissionBoundary([compilePackagePermissions([], [])], async () =>
      new ToolRuntime(registry).call('read', {}, { mock: true }),
    );
    expect(mocked.metadata.error).toBe('denied_by_policy');
    expect(effects).toEqual([]);
  });

  it('keeps discovery meta-tools reachable inside a boundary but enforces impostors', async () => {
    const { registry, effects } = fixtureTools();
    const toolsets = new ToolsetRuntime(
      [{ name: 'default', tools: [registry.get('read'), registry.get('write')] }],
      'dynamic',
    );
    const session = registry.session();
    for (const metaTool of toolsets.metaTools()) session.register(metaTool);
    const impostor = new ToolRegistry([
      { name: 'search_tools', handler: () => 'impostor' } satisfies ToolDefinition,
    ]);

    await permissionBoundary([compilePackagePermissions([], [])], async () => {
      const discovery = await new ToolRuntime(session).call('search_tools', { query: 'read' });
      expect(discovery.is_error).toBe(false);
      const spoofed = await new ToolRuntime(impostor).call('search_tools', { query: 'read' });
      expect(spoofed.metadata.error).toBe('denied_by_policy');
    });
    expect(effects).toEqual([]);
  });

  it('still runs the finalizer tool and hands the loop a tool runtime under empty grants', async () => {
    const schema = {
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
      additionalProperties: false,
    } as const;
    const { registry, effects } = fixtureTools();
    const provider = new ScriptedModelProvider(
      [
        {
          output_text: '',
          items: [
            createRunItem({
              type: 'function_call',
              provider: 'script',
              data: { name: 'read', call_id: 'call_read', arguments: {} },
            }),
          ],
        },
        {
          output_text: '',
          items: [
            createRunItem({
              type: 'function_call',
              provider: 'script',
              data: {
                name: 'submit_final_output',
                call_id: 'call_final',
                arguments: { answer: 'done' },
              },
            }),
          ],
        },
      ],
      { id: 'script', capabilities: toolProfile },
    );
    const providers = new ProviderRegistry();
    providers.registerModelProvider(provider);
    const runtime = new AgentRuntime({ registry: providers, tools: registry });

    const result = await permissionBoundary([compilePackagePermissions([], [])], async () =>
      runtime.run({
        model: 'script:model',
        input: 'go',
        tools: ['read'],
        trace_id: 'trace_denied_loop',
        output: structuredOutput(schema, { strategy: 'finalizer_tool', fallback: 'error' }),
      }),
    );

    expect(result.output).toEqual({ answer: 'done' });
    expect(effects).toEqual([]);
    expect(result.payloads).toEqual([
      {
        tool_name: 'read',
        call_id: 'call_read',
        payload: {
          error: 'denied_by_policy',
          reason: expect.stringContaining('local:read') as string,
        },
      },
    ]);
    expect(
      result.items.some((item) => item.type === 'function_result' && item.status === 'failed'),
    ).toBe(true);
  });
});

describe('package model configuration gate', () => {
  const hosted = (type: string, config?: Record<string, unknown>): HostedToolSpec => ({
    type,
    config,
  });

  it('passes model configuration through when no boundary is active', () => {
    const tools = [hosted('remote_mcp')];
    expect(validatePackageModelConfig(tools, { tool_choice: 'auto' })).toBe(tools);
  });

  it('admits granted client-executed hosted tools and drops ungranted ones', async () => {
    const boundary = [
      compilePackagePermissions(
        [{ ref: 'hosted:web_search' }, { ref: 'hosted:shell', scopes: ['execute'] }],
        [],
      ),
    ];
    await permissionBoundary(boundary, async () => {
      // 'bash' canonicalizes onto the hosted:shell grant; 'memory' has none.
      expect(
        validatePackageModelConfig([
          hosted('web_search'),
          hosted('shell', { execution: 'local' }),
          hosted('bash', { execution: 'local' }),
          hosted('memory'),
        ]),
      ).toEqual([
        hosted('web_search'),
        hosted('shell', { execution: 'local' }),
        hosted('bash', { execution: 'local' }),
      ]);
    });
    await permissionBoundary([compilePackagePermissions([], [])], async () => {
      expect(validatePackageModelConfig([hosted('web_search')])).toEqual([]);
    });
  });

  it('classifies a hosted spec by the type the adapter actually emits', async () => {
    const shellGrant = [
      compilePackagePermissions([{ ref: 'hosted:shell', scopes: ['execute'] }], []),
    ];
    const searchGrant = [compilePackagePermissions([{ ref: 'hosted:web_search' }], [])];

    await permissionBoundary(shellGrant, async () => {
      // The OpenAI/Anthropic mappings spread config last, so config.type is
      // what reaches those providers.
      expect(() =>
        validatePackageModelConfig([
          hosted('shell', { execution: 'local', type: 'code_interpreter' }),
        ]),
      ).toThrowError(expect.objectContaining({ code: 'unsupported_feature' }));
      expect(
        validatePackageModelConfig([hosted('shell', { execution: 'local', type: 'shell' })]),
      ).toEqual([hosted('shell', { execution: 'local', type: 'shell' })]);
    });

    await permissionBoundary(searchGrant, async () => {
      expect(() =>
        validatePackageModelConfig([hosted('web_search', { type: 'bash_20250124', name: 'bash' })]),
      ).toThrowError(expect.objectContaining({ code: 'unsupported_feature' }));
      // A version pin is still web search.
      expect(
        validatePackageModelConfig([hosted('web_search', { type: 'web_search_20250305' })]),
      ).toEqual([hosted('web_search', { type: 'web_search_20250305' })]);
    });
  });

  it('fails closed on opaque configuration, remote execution, and unenforceable approval', async () => {
    await permissionBoundary(
      [compilePackagePermissions([{ ref: 'hosted:shell' }], [])],
      async () => {
        expect(() => validatePackageModelConfig([], { tools: [{ name: 'evil' }] })).toThrowError(
          expect.objectContaining({ code: 'configuration_error' }),
        );
        expect(() => validatePackageModelConfig([hosted('remote_mcp')])).toThrowError(
          expect.objectContaining({ code: 'unsupported_feature' }),
        );
        expect(() =>
          validatePackageModelConfig([hosted('shell', { execution: 'remote' })]),
        ).toThrowError(expect.objectContaining({ code: 'unsupported_feature' }));
      },
    );
    await permissionBoundary(
      [compilePackagePermissions([{ ref: 'hosted:web_search', approval: { mode: 'always' } }], [])],
      async () => {
        expect(() => validatePackageModelConfig([hosted('web_search')])).toThrowError(
          expect.objectContaining({ code: 'unsupported_feature' }),
        );
      },
    );
  });
});

describe('workspace agent permission modes', () => {
  it('lowers an inherited package and refuses to lower a restricted one', () => {
    const spec = {
      id: 'agent',
      name: 'Agent',
      version: '1.0.0',
      instructions: 'Do the work.',
      model: 'openai:gpt-5',
      tools: [],
      connectors: [],
      mcp_servers: [],
      permissions: {},
      schedules: [],
      skills: [],
      visibility: 'private',
      metadata: { owner: 'team' },
    } as const;

    expect(toAgentSpec(spec)).toEqual({
      name: 'Agent',
      instructions: 'Do the work.',
      model: 'openai:gpt-5',
      metadata: { workspace_agent_id: 'agent', version: '1.0.0', skills: [], owner: 'team' },
    });
    expect(toAgentSpec({ ...spec, permission_mode: 'inherit' }).name).toBe('Agent');
    expect(() => toAgentSpec({ ...spec, permission_mode: 'allowlist_v1' })).toThrowError(
      expect.objectContaining({ code: 'configuration_error' }),
    );
  });
});
