import type { MCPConnectionSpec } from '../providers/base.js';
import { MCPError } from '../core/errors.js';
import type { ToolDefinition } from '../tools/types.js';
import { MCPClient, mcpToolDefinitions } from './client.js';
import type { MCPRoute, MCPServerSpec, MCPTrustPolicy } from './types.js';
import { MCPTrustPresets } from './client.js';

export interface ResolvedMCPToolset {
  readonly route: MCPRoute;
  readonly tools: readonly ToolDefinition[];
  readonly connections: readonly MCPConnectionSpec[];
  readonly metadata: Readonly<Record<string, unknown>>;
}

export class MCPToolset {
  constructor(
    readonly server: MCPServerSpec,
    readonly route: MCPRoute,
    private readonly options: { readonly client?: MCPClient; readonly trust?: MCPTrustPolicy } = {},
  ) {}

  async resolve(): Promise<ResolvedMCPToolset> {
    const trust = await (this.options.trust ?? MCPTrustPresets.explicit()).evaluate(this.server);
    if (!trust.allowed) {
      throw new MCPError(trust.reason ?? `MCP server '${this.server.name}' is not trusted.`, {
        code: 'mcp_untrusted',
      });
    }
    if (this.route === 'local') {
      if (this.options.client === undefined)
        throw new MCPError('Local MCP toolsets require a client.', {
          code: 'mcp_client_required',
        });
      return {
        route: this.route,
        tools: await mcpToolDefinitions(this.options.client),
        connections: [],
        metadata: { server: this.server.name, trust: trust.metadata },
      };
    }
    return {
      route: this.route,
      tools: [],
      connections: [
        {
          id: this.server.name,
          transport: 'provider_native',
          server_label: this.server.name,
          config: {
            url: this.server.url,
            allowed_tools: this.server.allowed_tools,
            scopes: this.server.scopes,
          },
        },
      ],
      metadata: { server: this.server.name, trust: trust.metadata },
    };
  }
}
