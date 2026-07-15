import { MCPAuthenticationError, MCPError } from '../core/errors.js';
import { AgentEventTypes, createAgentEvent, type AgentEvent } from '../core/events.js';
import { toolResult, type ToolDefinition } from '../tools/types.js';
import {
  MCP_PROTOCOL_VERSIONS,
  type MCPContent,
  type MCPProtocolVersion,
  type MCPServerSpec,
  type MCPTokenProvider,
  type MCPTool,
  type MCPToolResult,
  type MCPTransport,
  type MCPTrustPolicy,
} from './types.js';

export class MCPTrustPresets {
  static trusted(): MCPTrustPolicy {
    return { evaluate: () => ({ allowed: true, metadata: { preset: 'trusted' } }) };
  }

  static localOnly(): MCPTrustPolicy {
    return {
      evaluate: (server) => ({
        allowed: server.remote !== true,
        reason: server.remote === true ? 'Remote MCP servers are not trusted.' : undefined,
        metadata: { preset: 'local_only' },
      }),
    };
  }

  static explicit(): MCPTrustPolicy {
    return {
      evaluate: (server) => ({
        allowed: server.trusted === true,
        reason: server.trusted === true ? undefined : 'Server must be explicitly trusted.',
        metadata: { preset: 'explicit' },
      }),
    };
  }
}

export interface MCPClientOptions {
  readonly token_provider?: MCPTokenProvider;
  readonly trust?: MCPTrustPolicy;
  readonly emit?: (event: AgentEvent) => void | Promise<void>;
  readonly cache_ttl_ms?: number;
  readonly now?: () => number;
}

export class MCPClient {
  private initializedVersion?: MCPProtocolVersion;
  private toolsCache?: { readonly expires: number; readonly tools: readonly MCPTool[] };
  private readonly trust: MCPTrustPolicy;
  private readonly now: () => number;

  constructor(
    readonly server: MCPServerSpec,
    private readonly transport: MCPTransport,
    private readonly options: MCPClientOptions = {},
  ) {
    this.trust = options.trust ?? MCPTrustPresets.explicit();
    this.now = options.now ?? Date.now;
  }

  async initialize(): Promise<MCPProtocolVersion> {
    await this.assertTrusted();
    const requested = latestCommonVersion(this.server.protocol_versions);
    const response = asRecord(
      await this.request('initialize', {
        protocolVersion: requested,
        capabilities: {},
        clientInfo: { name: 'blackbox-ts', version: '0.1.0' },
      }),
    );
    const negotiated = response.protocolVersion;
    if (
      typeof negotiated !== 'string' ||
      !MCP_PROTOCOL_VERSIONS.includes(negotiated as MCPProtocolVersion)
    ) {
      throw new MCPError(
        `MCP server '${this.server.name}' selected unsupported protocol '${String(negotiated)}'.`,
        {
          code: 'mcp_protocol_mismatch',
        },
      );
    }
    if (
      !(this.server.protocol_versions ?? MCP_PROTOCOL_VERSIONS).includes(
        negotiated as MCPProtocolVersion,
      )
    ) {
      throw new MCPError(
        `MCP server '${this.server.name}' selected unoffered protocol '${negotiated}'.`,
        {
          code: 'mcp_protocol_mismatch',
        },
      );
    }
    this.initializedVersion = negotiated as MCPProtocolVersion;
    return this.initializedVersion;
  }

  async listTools(options: { readonly refresh?: boolean } = {}): Promise<readonly MCPTool[]> {
    if (this.initializedVersion === undefined) await this.initialize();
    if (!options.refresh && this.toolsCache !== undefined && this.toolsCache.expires > this.now()) {
      await this.emit(AgentEventTypes.MCP_TOOLS_CACHE_HIT, {});
      return this.toolsCache.tools;
    }
    await this.emit(AgentEventTypes.MCP_LIST_TOOLS_STARTED, {});
    const response = asRecord(await this.request('tools/list', {}));
    const discovered = Array.isArray(response.tools) ? response.tools.map(readTool) : [];
    const tools: MCPTool[] = [];
    for (const tool of discovered) {
      if (!this.isNamedToolAllowed(tool.name)) continue;
      const trust = await this.trust.evaluate(this.server, tool);
      if (trust.allowed) tools.push(tool);
    }
    this.toolsCache = {
      expires: this.now() + (this.options.cache_ttl_ms ?? 30_000),
      tools,
    };
    await this.emit(AgentEventTypes.MCP_LIST_TOOLS_COMPLETED, {
      discovered: discovered.length,
      visible: tools.length,
    });
    return tools;
  }

  invalidateTools(reason = 'listChanged'): void {
    this.toolsCache = undefined;
    void this.emit(AgentEventTypes.MCP_TOOLS_CACHE_INVALIDATED, { reason });
  }

  async callTool(
    name: string,
    arguments_: Readonly<Record<string, unknown>>,
  ): Promise<MCPToolResult> {
    const tool = (await this.listTools()).find((candidate) => candidate.name === name);
    if (tool === undefined) {
      throw new MCPError(`MCP tool '${name}' is not visible on '${this.server.name}'.`, {
        code: 'mcp_tool_not_found',
      });
    }
    await this.assertTrusted(tool);
    await this.emit(AgentEventTypes.MCP_CALL_STARTED, { tool: name });
    const result = normalizeResult(
      await this.request('tools/call', { name, arguments: arguments_ }),
    );
    const limit = this.server.max_output_bytes ?? 1024 * 1024;
    const size = Buffer.byteLength(JSON.stringify(result), 'utf8');
    if (size > limit) {
      await this.emit(AgentEventTypes.MCP_OUTPUT_TRUNCATED, { tool: name, size, limit });
      throw new MCPError(`MCP tool '${name}' output exceeded ${limit} bytes.`, {
        code: 'mcp_output_too_large',
      });
    }
    await this.emit(AgentEventTypes.MCP_CALL_COMPLETED, { tool: name, is_error: result.isError });
    return result;
  }

  async close(): Promise<void> {
    await this.transport.close?.();
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    try {
      return await this.requestWithToken(method, params, false);
    } catch (cause) {
      if (!(cause instanceof MCPAuthenticationError) || this.options.token_provider === undefined) {
        throw cause;
      }
      await this.emit(AgentEventTypes.MCP_AUTH_CHALLENGE, { method });
      return this.requestWithToken(method, params, true);
    }
  }

  private async requestWithToken(method: string, params: unknown, forceRefresh: boolean) {
    const token = await this.options.token_provider?.token({
      force_refresh: forceRefresh,
      scopes: this.server.scopes,
    });
    return this.transport.request(method, params, {
      headers: token === undefined ? {} : { Authorization: `Bearer ${token}` },
      timeout_ms: this.server.timeout_ms,
    });
  }

  private async assertTrusted(tool?: MCPTool): Promise<void> {
    const decision = await this.trust.evaluate(this.server, tool);
    await this.emit(AgentEventTypes.MCP_TRUST_EVALUATED, {
      tool: tool?.name,
      allowed: decision.allowed,
      reason: decision.reason,
    });
    if (!decision.allowed) {
      throw new MCPError(decision.reason ?? `MCP server '${this.server.name}' is not trusted.`, {
        code: 'mcp_untrusted',
      });
    }
  }

  private isNamedToolAllowed(name: string): boolean {
    if (this.server.denied_tools?.includes(name) === true) return false;
    return this.server.allowed_tools === undefined || this.server.allowed_tools.includes(name);
  }

  private async emit(type: string, data: Readonly<Record<string, unknown>>): Promise<void> {
    await this.options.emit?.(
      createAgentEvent({ type, data: { server: this.server.name, ...data } }),
    );
  }
}

export function mcpToolDefinitions(client: MCPClient): Promise<readonly ToolDefinition[]> {
  return client.listTools().then((tools) =>
    tools.map((tool) => ({
      name: `mcp:${client.server.name}.${tool.name}`,
      description: tool.description,
      input_schema: tool.inputSchema,
      risk: tool.risk,
      scopes: tool.scopes,
      handler: async (arguments_) => {
        const result = await client.callTool(tool.name, arguments_);
        const content = result.content.map(contentText).join('\n');
        return toolResult(content, {
          is_error: result.isError,
          payload: result.structuredContent,
          metadata: result.metadata,
        });
      },
    })),
  );
}

function latestCommonVersion(
  versions: readonly MCPProtocolVersion[] | undefined,
): MCPProtocolVersion {
  const allowed = versions ?? MCP_PROTOCOL_VERSIONS;
  const version = [...MCP_PROTOCOL_VERSIONS]
    .reverse()
    .find((candidate) => allowed.includes(candidate));
  if (version === undefined)
    throw new MCPError('No supported MCP protocol version is configured.', {
      code: 'mcp_protocol_mismatch',
    });
  return version;
}

function readTool(value: unknown): MCPTool {
  const record = asRecord(value);
  if (typeof record.name !== 'string')
    throw new MCPError('MCP tool has no valid name.', { code: 'mcp_invalid_tool' });
  return {
    name: record.name,
    description: typeof record.description === 'string' ? record.description : undefined,
    inputSchema: record.inputSchema,
    risk: typeof record.risk === 'string' ? record.risk : undefined,
    scopes: Array.isArray(record.scopes)
      ? record.scopes.filter((scope): scope is string => typeof scope === 'string')
      : undefined,
    metadata: asOptionalRecord(record.metadata),
  };
}

function normalizeResult(value: unknown): MCPToolResult {
  const record = asRecord(value);
  const content = Array.isArray(record.content) ? record.content.map(readContent) : [];
  return {
    content,
    isError: record.isError === true,
    structuredContent: record.structuredContent,
    metadata: asOptionalRecord(record.metadata),
  };
}

function readContent(value: unknown): MCPContent {
  const record = asRecord(value);
  if (record.type === 'text' && typeof record.text === 'string')
    return { type: 'text', text: record.text };
  if (
    record.type === 'image' &&
    typeof record.data === 'string' &&
    typeof record.mimeType === 'string'
  ) {
    return { type: 'image', data: record.data, mimeType: record.mimeType };
  }
  if (record.type === 'resource' && typeof record.uri === 'string') {
    return {
      type: 'resource',
      uri: record.uri,
      text: typeof record.text === 'string' ? record.text : undefined,
    };
  }
  throw new MCPError('MCP result contained unsupported content.', { code: 'mcp_invalid_result' });
}

function contentText(content: MCPContent): string {
  if (content.type === 'text') return content.text;
  if (content.type === 'resource') return content.text ?? content.uri;
  return `[image:${content.mimeType}]`;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MCPError('MCP response must be an object.', { code: 'mcp_invalid_response' });
  }
  return value as Readonly<Record<string, unknown>>;
}

function asOptionalRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}
