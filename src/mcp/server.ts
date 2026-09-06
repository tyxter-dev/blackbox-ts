import { MCPError } from '../core/errors.js';
import {
  activePermissions,
  packageCallApproved,
  packageDecision,
  toolRequest,
} from '../core/tool-permissions.js';
import type { ToolDefinition } from '../tools/types.js';
import { MCP_PROTOCOL_VERSIONS, type MCPProtocolVersion, type MCPToolResult } from './types.js';

export class MCPServer {
  private readonly tools = new Map<string, ToolDefinition>();
  private readonly toolChangeListeners = new Set<() => void>();

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
    for (const listener of this.toolChangeListeners) listener();
  }

  unregisterTool(name: string): boolean {
    const removed = this.tools.delete(name);
    if (removed) for (const listener of this.toolChangeListeners) listener();
    return removed;
  }

  onToolsChanged(listener: () => void): () => void {
    this.toolChangeListeners.add(listener);
    return () => this.toolChangeListeners.delete(listener);
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
        serverInfo: { name: this.name, version: '0.2.0' },
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
      this.assertPackagePermits(request.name, tool, arguments_);
      const value = await tool.handler(arguments_, {
        signal: new AbortController().signal,
        values: {},
      });
      return normalizeHandlerResult(value);
    }
    throw new MCPError(`Unsupported MCP method '${method}'.`, { code: 'mcp_method_not_found' });
  }

  /**
   * Decide a `tools/call` against the package boundary.
   *
   * This branch runs a registered handler directly, without the tool runtime,
   * so it is the second place a package grant has to be checked. The request
   * is built on this server's MCP ref (`mcp:<this server's name>.<tool>`),
   * which is also the ref a client addressing this server under that name
   * derives for the same tool, so one grant admits the whole hop instead of
   * the two ends disagreeing. The registry entry is re-read and pinned by
   * identity in the shape of the parent's pin ((parent)
   * src/blackbox/mcp/connector.py L211-234), but there is no asynchronous
   * policy step on this side -- nothing is awaited between the caller's lookup
   * and this re-read -- so the pin only guards against a concurrent
   * `registerTool`/`unregisterTool` of the same name. There is no event
   * channel here, so a refusal is only the raised {@link MCPError}. With no
   * boundary active nothing runs.
   */
  private assertPackagePermits(
    name: string,
    tool: ToolDefinition,
    arguments_: Readonly<Record<string, unknown>>,
  ): void {
    if (activePermissions().length === 0) return;
    const fresh = this.tools.get(name);
    if (fresh?.handler === undefined) {
      throw new MCPError(`MCP tool '${name}' was not found.`, { code: 'mcp_tool_not_found' });
    }
    const ref = `mcp:${this.name}.${fresh.name}`;
    const base = toolRequest(fresh, { checkpoint: 'before_mcp_call', arguments: arguments_ });
    const request = {
      ...base,
      action: ref,
      metadata: {
        ...base.metadata,
        mcp: true,
        server: this.name,
        tool: fresh.name,
        ref,
        tool_ref: ref,
      },
    };
    const decision = packageDecision(request);
    if (
      decision.verdict === 'deny' ||
      (decision.verdict === 'require_approval' && !packageCallApproved(request))
    ) {
      throw new MCPError(decision.reason ?? 'Package permission denied MCP tool.');
    }
    if (fresh !== tool) {
      throw new MCPError('MCP tool changed during policy evaluation; retry required.');
    }
  }
}

export function inProcessMCPTransport(server: MCPServer) {
  return {
    request: (method: string, params: unknown) => server.handle(method, params),
    onNotification: (listener: (notification: { readonly method: string }) => void) =>
      server.onToolsChanged(() => listener({ method: 'notifications/tools/list_changed' })),
  };
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
