import { MCPError } from '../core/errors.js';
import type { ToolDefinition } from '../tools/types.js';
import { MCP_PROTOCOL_VERSIONS, type MCPProtocolVersion, type MCPToolResult } from './types.js';

export class MCPServer {
  private readonly tools = new Map<string, ToolDefinition>();

  constructor(
    readonly name: string,
    tools: readonly ToolDefinition[] = [],
    readonly protocolVersions: readonly MCPProtocolVersion[] = MCP_PROTOCOL_VERSIONS,
  ) {
    for (const tool of tools) this.registerTool(tool);
  }

  registerTool(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) {
      throw new MCPError(`MCP tool '${tool.name}' is already registered.`, {
        code: 'mcp_duplicate_tool',
      });
    }
    this.tools.set(tool.name, tool);
  }

  async handle(method: string, params: unknown): Promise<unknown> {
    if (method === 'initialize') {
      const request = asRecord(params);
      const requested = request.protocolVersion;
      if (
        typeof requested !== 'string' ||
        !this.protocolVersions.includes(requested as MCPProtocolVersion)
      ) {
        throw new MCPError(`Unsupported MCP protocol '${String(requested)}'.`, {
          code: 'mcp_protocol_mismatch',
        });
      }
      return {
        protocolVersion: requested,
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: this.name, version: '0.1.0' },
      };
    }
    if (method === 'tools/list') {
      return {
        tools: [...this.tools.values()].map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.input_schema,
          risk: tool.risk,
          scopes: tool.scopes,
        })),
      };
    }
    if (method === 'tools/call') {
      const request = asRecord(params);
      if (typeof request.name !== 'string')
        throw new MCPError('MCP call has no tool name.', { code: 'mcp_invalid_request' });
      const tool = this.tools.get(request.name);
      if (tool?.handler === undefined)
        throw new MCPError(`MCP tool '${request.name}' was not found.`, {
          code: 'mcp_tool_not_found',
        });
      const arguments_ = asRecord(request.arguments ?? {});
      const value = await tool.handler(arguments_, {
        signal: new AbortController().signal,
        values: {},
      });
      return normalizeHandlerResult(value);
    }
    throw new MCPError(`Unsupported MCP method '${method}'.`, { code: 'mcp_method_not_found' });
  }
}

export function inProcessMCPTransport(server: MCPServer) {
  return { request: (method: string, params: unknown) => server.handle(method, params) };
}

function normalizeHandlerResult(value: unknown): MCPToolResult {
  if (
    typeof value === 'object' &&
    value !== null &&
    'content' in value &&
    typeof value.content === 'string'
  ) {
    return {
      content: [{ type: 'text', text: value.content }],
      isError: 'is_error' in value && value.is_error === true,
      structuredContent: 'payload' in value ? value.payload : undefined,
      metadata:
        'metadata' in value && typeof value.metadata === 'object' && value.metadata !== null
          ? (value.metadata as Readonly<Record<string, unknown>>)
          : undefined,
    };
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  return { content: [{ type: 'text', text }] };
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MCPError('MCP request must be an object.', { code: 'mcp_invalid_request' });
  }
  return value as Readonly<Record<string, unknown>>;
}
