import { describe, expect, it } from 'vitest';

import {
  MCPAuthenticationError,
  MCPClient,
  MCPServer,
  MCPToolset,
  MCPTrustPresets,
  inProcessMCPTransport,
  mcpToolDefinitions,
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
    client.invalidateTools();
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
});
