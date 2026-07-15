import { describe, expect, it, vi } from 'vitest';

import {
  MCPAuthenticationError,
  MCPClient,
  FetchMCPTransport,
  MCPServer,
  MCPToolset,
  MCPTrustPresets,
  inProcessMCPTransport,
  mcpToolDefinitions,
  mcpToolCacheKey,
  toolResult,
  type MCPRequestContext,
} from '../../src/index.js';

describe('MCP boundary', () => {
  it('negotiates, filters, caches, invalidates, and bridges namespaced tools', async () => {
    let calls = 0;
    const server = new MCPServer('local', [
      { name: 'echo', description: 'Echo text', handler: ({ text }) => String(text) },
      { name: 'hidden', handler: () => 'hidden' },
    ]);
    const transport = inProcessMCPTransport(server);
    const countingTransport = {
      request: (method: string, params: unknown, context: MCPRequestContext) => {
        if (method === 'tools/list') calls += 1;
        return transport.request(method, params, context);
      },
      onNotification: transport.onNotification,
    };
    const client = new MCPClient(
      {
        name: 'local',
        transport: 'stdio',
        trusted: true,
        allowed_tools: ['echo'],
      },
      countingTransport,
    );

    expect((await client.listTools()).map((tool) => tool.name)).toEqual(['echo']);
    await client.listTools();
    expect(calls).toBe(1);
    server.registerTool({ name: 'later', handler: () => 'later' });
    await client.listTools();
    expect(calls).toBe(2);
    const [definition] = await mcpToolDefinitions(client);
    expect(definition?.name).toBe('mcp:local.echo');
    const result = await definition?.handler?.(
      { text: 'hello' },
      { signal: new AbortController().signal, values: {} },
    );
    expect(result).toMatchObject({ content: 'hello', is_error: false });
  });

  it('evaluates trust before discovery and refreshes authentication only once', async () => {
    let dispatches = 0;
    const blocked = new MCPClient(
      { name: 'remote', transport: 'http', url: 'https://example.test', remote: true },
      {
        request: async () => {
          dispatches += 1;
          return {};
        },
      },
      { trust: MCPTrustPresets.localOnly() },
    );
    await expect(blocked.listTools()).rejects.toMatchObject({ code: 'mcp_untrusted' });
    expect(dispatches).toBe(0);

    const tokens: boolean[] = [];
    const headers: string[] = [];
    const authenticated = new MCPClient(
      { name: 'auth', transport: 'http', remote: true, trusted: true },
      {
        request: async (method, _params, context) => {
          headers.push(context.headers.Authorization ?? '');
          if (headers.length === 1) {
            throw new MCPAuthenticationError('expired', { server: 'auth', status_code: 401 });
          }
          if (method === 'initialize') {
            return { protocolVersion: '2025-06-18', capabilities: {} };
          }
          return { tools: [] };
        },
      },
      {
        token_provider: {
          token: ({ force_refresh } = {}) => {
            tokens.push(force_refresh ?? false);
            return force_refresh ? 'fresh' : 'stale';
          },
        },
      },
    );
    await authenticated.listTools();
    expect(tokens.slice(0, 2)).toEqual([false, true]);
    expect(headers.slice(0, 2)).toEqual(['Bearer stale', 'Bearer fresh']);
  });

  it('rejects oversized tool output', async () => {
    const server = new MCPServer('limited', [
      { name: 'large', handler: () => toolResult('x'.repeat(100)) },
    ]);
    const client = new MCPClient(
      { name: 'limited', transport: 'stdio', trusted: true, max_output_bytes: 20 },
      inProcessMCPTransport(server),
    );

    await expect(client.callTool('large', {})).rejects.toMatchObject({
      code: 'mcp_output_too_large',
    });
  });

  it('keeps provider-native MCP routing distinct from local dispatch', async () => {
    const toolset = new MCPToolset(
      {
        name: 'remote',
        transport: 'streamable_http',
        url: 'https://mcp.example.test',
        trusted: true,
        allowed_tools: ['search'],
      },
      'provider_native',
    );
    const resolved = await toolset.resolve();
    expect(resolved.tools).toEqual([]);
    expect(resolved.connections).toHaveLength(1);
    expect(resolved.connections[0]).toMatchObject({
      id: 'remote',
      transport: 'provider_native',
    });
    expect(resolved.connections[0]?.config?.url).toBe('https://mcp.example.test');
  });

  it('propagates tool-handler cancellation into the MCP transport', async () => {
    let observedSignal: AbortSignal | undefined;
    const client = new MCPClient(
      { name: 'cancel', transport: 'stdio', trusted: true },
      {
        request: (method, _params, context) => {
          if (method === 'initialize') {
            return Promise.resolve({ protocolVersion: '2025-06-18', capabilities: {} });
          }
          if (method === 'tools/list') {
            return Promise.resolve({ tools: [{ name: 'wait' }] });
          }
          observedSignal = context.signal;
          return new Promise((_resolve, reject) => {
            context.signal?.addEventListener(
              'abort',
              () =>
                reject(
                  context.signal?.reason instanceof Error
                    ? context.signal.reason
                    : new Error('MCP call cancelled.'),
                ),
              { once: true },
            );
          });
        },
      },
    );
    const [definition] = await mcpToolDefinitions(client);
    const controller = new AbortController();
    const pending = definition?.handler?.({}, { signal: controller.signal, values: {} });
    await vi.waitFor(() => expect(observedSignal).toBeDefined());
    controller.abort(new Error('cancel MCP call'));

    await expect(pending).rejects.toThrow('cancel MCP call');
    expect(observedSignal?.aborted).toBe(true);
  });

  it('keeps authentication secrets out of cache identities and representations', () => {
    const server = {
      name: 'private',
      transport: 'streamable_http' as const,
      url: 'https://user:password@example.test/mcp?access_token=url-secret',
      remote: true,
      trusted: true,
    };
    const first = mcpToolCacheKey(server, 'tenant-secret-one');
    const second = mcpToolCacheKey(server, 'tenant-secret-two');
    const client = new MCPClient(
      server,
      { request: async () => ({}) },
      {
        token_provider: {
          cache_key: 'tenant-secret-one',
          token: () => 'bearer-secret',
        },
      },
    );

    expect(first).not.toBe(second);
    expect(first).toHaveLength(64);
    expect(JSON.stringify(client)).not.toMatch(/password|url-secret|tenant-secret|bearer-secret/);
  });

  it('maps JSON and SSE HTTP responses and rejects mismatched JSON-RPC ids', async () => {
    const responses = [
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [] } }), {
        headers: { 'content-type': 'application/json' },
      }),
      new Response('event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"ok":true}}\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      }),
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 99, result: {} }), {
        headers: { 'content-type': 'application/json' },
      }),
    ];
    const transport = new FetchMCPTransport(
      'https://example.test/mcp',
      vi.fn(async () => responses.shift()!),
    );
    const context = { headers: {} };

    await expect(transport.request('tools/list', {}, context)).resolves.toEqual({ tools: [] });
    await expect(transport.request('ping', {}, context)).resolves.toEqual({ ok: true });
    await expect(transport.request('ping', {}, context)).rejects.toMatchObject({
      code: 'mcp_invalid_response',
    });
  });
});
