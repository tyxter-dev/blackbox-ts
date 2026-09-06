import { MCPAuthenticationError, MCPError } from '../core/errors.js';
import { AgentEventTypes, createAgentEvent, type AgentEvent } from '../core/events.js';
import type { PolicyRequest } from '../core/policy.js';
import {
  activePermissions,
  packageCallApproved,
  packageDecision,
} from '../core/tool-permissions.js';
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
  /** The one `tools/list` in flight, shared by every caller that misses the cache. */
  private pendingTools?: Promise<readonly MCPTool[]>;
  private readonly trust: MCPTrustPolicy;
  private readonly now: () => number;
  private readonly unsubscribeNotifications?: () => void;
  readonly cache_key: string;

  constructor(
    readonly server: MCPServerSpec,
    private readonly transport: MCPTransport,
    private readonly options: MCPClientOptions = {},
  ) {
    this.trust = options.trust ?? MCPTrustPresets.explicit();
    this.now = options.now ?? Date.now;
    this.cache_key = mcpToolCacheKey(server, options.token_provider?.cache_key);
    this.unsubscribeNotifications = transport.onNotification?.((notification) => {
      if (
        notification.method === 'notifications/tools/list_changed' ||
        notification.method === 'tools/list_changed'
      ) {
        this.invalidateTools(notification.method);
      }
    });
  }

  async initialize(options: { readonly signal?: AbortSignal } = {}): Promise<MCPProtocolVersion> {
    await this.assertTrusted();
    const requested = latestCommonVersion(this.server.protocol_versions);
    const response = asRecord(
      await this.request(
        'initialize',
        {
          protocolVersion: requested,
          capabilities: {},
          clientInfo: { name: 'blackbox-ts', version: '0.1.0' },
        },
        options.signal,
      ),
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

  /**
   * List the visible tools, from the cache while it is fresh.
   *
   * Every caller that misses the cache joins the one `tools/list` already in
   * flight instead of starting its own, so concurrent callers resolve the same
   * descriptor objects. A refetch that discovers the descriptors unchanged
   * keeps the objects the cache already held: descriptor identity therefore
   * changes only when the list really changed or an invalidation dropped it,
   * which is what the dispatch pin in {@link callTool} compares.
   */
  async listTools(
    options: { readonly refresh?: boolean; readonly signal?: AbortSignal } = {},
  ): Promise<readonly MCPTool[]> {
    if (this.initializedVersion === undefined) await this.initialize({ signal: options.signal });
    if (!options.refresh && this.toolsCache !== undefined && this.toolsCache.expires > this.now()) {
      await this.emit(AgentEventTypes.MCP_TOOLS_CACHE_HIT, {});
      return this.toolsCache.tools;
    }
    if (this.pendingTools === undefined) {
      const pending = this.fetchTools(options.signal).finally(() => {
        if (this.pendingTools === pending) this.pendingTools = undefined;
      });
      this.pendingTools = pending;
    }
    return this.pendingTools;
  }

  private async fetchTools(signal?: AbortSignal): Promise<readonly MCPTool[]> {
    await this.emit(AgentEventTypes.MCP_LIST_TOOLS_STARTED, {});
    const response = asRecord(await this.request('tools/list', {}, signal));
    const discovered = Array.isArray(response.tools) ? response.tools.map(readTool) : [];
    const fetched: MCPTool[] = [];
    for (const tool of discovered) {
      if (!this.isNamedToolAllowed(tool.name)) continue;
      const trust = await this.trust.evaluate(this.server, tool);
      if (trust.allowed) fetched.push(tool);
    }
    // An expired cache that was never invalidated still holds the descriptors
    // callers resolved from; keep those objects when the server reports the
    // same list, so a TTL refresh alone never manufactures a "changed" tool.
    const previous = this.toolsCache?.tools;
    const tools =
      previous !== undefined && stableJson(previous) === stableJson(fetched) ? previous : fetched;
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
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<MCPToolResult> {
    const tool = (await this.listTools({ signal: options.signal })).find(
      (candidate) => candidate.name === name,
    );
    if (tool === undefined) {
      throw new MCPError(`MCP tool '${name}' is not visible on '${this.server.name}'.`, {
        code: 'mcp_tool_not_found',
      });
    }
    await this.assertTrusted(tool);
    await this.assertPackagePermits(tool, arguments_, options.signal);
    await this.emit(AgentEventTypes.MCP_CALL_STARTED, { tool: name });
    const result = normalizeResult(
      await this.request('tools/call', { name, arguments: arguments_ }, options.signal),
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
    this.unsubscribeNotifications?.();
    await this.transport.close?.();
  }

  toJSON(): Readonly<Record<string, unknown>> {
    return {
      server: {
        name: this.server.name,
        transport: this.server.transport,
        remote: this.server.remote ?? false,
      },
      protocol_version: this.initializedVersion,
      cache_key: this.cache_key,
    };
  }

  toString(): string {
    return `MCPClient(server=${JSON.stringify(this.server.name)}, transport=${JSON.stringify(this.server.transport)})`;
  }

  [inspect.custom](): string {
    return this.toString();
  }

  private async request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    try {
      return await this.requestWithToken(method, params, false, signal);
    } catch (cause) {
      if (!(cause instanceof MCPAuthenticationError) || this.options.token_provider === undefined) {
        throw cause;
      }
      await this.emit(AgentEventTypes.MCP_AUTH_CHALLENGE, { method });
      return this.requestWithToken(method, params, true, signal);
    }
  }

  private async requestWithToken(
    method: string,
    params: unknown,
    forceRefresh: boolean,
    signal?: AbortSignal,
  ) {
    const token = await this.options.token_provider?.token({
      force_refresh: forceRefresh,
      scopes: this.server.scopes,
    });
    return this.transport.request(method, params, {
      headers: token === undefined ? {} : { Authorization: `Bearer ${token}` },
      signal,
      timeout_ms: this.server.timeout_ms,
    });
  }

  /**
   * Decide this call against the package boundary, on a descriptor re-resolved
   * after the asynchronous trust callback.
   *
   * The trust policy is an `await`, so the descriptor the caller resolved may
   * have been replaced (a `list_changed` notification, or a refresh that found
   * a different list) while it ran. The decision is therefore taken on the
   * fresh descriptor and the dispatch below is pinned to it: a descriptor
   * swapped between decision and dispatch is refused rather than executed on
   * a stale verdict. The re-resolution is the parent's synchronous registry
   * lookup ((parent) connector.py L387-395): it reads the cache this call
   * resolved from even if its TTL has since lapsed, and fetches again only
   * when an invalidation dropped that cache -- so the pin fires on a real
   * change, never on a timer. With no boundary active this method returns
   * before resolving anything.
   */
  private async assertPackagePermits(
    tool: MCPTool,
    arguments_: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<void> {
    if (activePermissions().length === 0) return;
    const registry = this.toolsCache?.tools ?? (await this.listTools({ signal }));
    const fresh = registry.find((candidate) => candidate.name === tool.name);
    if (fresh === undefined) {
      throw new MCPError(`MCP tool '${tool.name}' is not visible on '${this.server.name}'.`, {
        code: 'mcp_tool_not_found',
      });
    }
    const request = mcpPolicyRequest(this.server, fresh, arguments_);
    const decision = packageDecision(request);
    if (
      decision.verdict === 'deny' ||
      (decision.verdict === 'require_approval' && !packageCallApproved(request))
    ) {
      await this.emit(AgentEventTypes.TOOL_CHOICE_REJECTED, {
        name: request.action,
        reason: decision.reason,
        checkpoint: 'before_mcp_call',
      });
      throw new MCPError(decision.reason ?? 'Package permission denied MCP tool.');
    }
    if (fresh !== tool) {
      throw new MCPError('MCP tool changed during policy evaluation; retry required.');
    }
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

export function mcpToolCacheKey(server: MCPServerSpec, authCacheIdentity?: string): string {
  const identity = {
    server: server.name,
    transport: server.transport,
    endpoint:
      server.transport === 'stdio'
        ? { command: server.command, arguments: server.arguments ?? [] }
        : { url_hash: hashValue(server.url ?? '') },
    protocol_versions: [...(server.protocol_versions ?? MCP_PROTOCOL_VERSIONS)].sort(),
    allowed_tools: [...(server.allowed_tools ?? [])].sort(),
    denied_tools: [...(server.denied_tools ?? [])].sort(),
    scopes: [...(server.scopes ?? [])].sort(),
    trusted: server.trusted === true,
    remote: server.remote === true,
    auth_identity_hash: authCacheIdentity === undefined ? undefined : hashValue(authCacheIdentity),
  };
  return hashValue(identity);
}

export function mcpToolDefinitions(client: MCPClient): Promise<readonly ToolDefinition[]> {
  return client.listTools().then((tools) =>
    tools.map((tool) => ({
      name: mcpToolRef(client.server.name, tool.name),
      description: tool.description,
      input_schema: tool.inputSchema,
      risk: tool.risk,
      scopes: operationScopes(tool),
      metadata: mcpToolMetadata(client.server.name, tool),
      handler: async (arguments_, context) => {
        const result = await client.callTool(tool.name, arguments_, { signal: context.signal });
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

/** The canonical package ref for one MCP tool, shared by every gate on the hop. */
function mcpToolRef(server: string, tool: string): string {
  return `mcp:${server}.${tool}`;
}

/**
 * The parent's operation-scope ladder ((parent) src/blackbox/mcp/connector.py
 * L1072-1080): an explicit `permission_scopes` wins, then a destructive tool
 * is `delete`, a read-only tool is `read`, and anything else is `execute`.
 *
 * Divergence: a descriptor that already declares a `scopes` array keeps it,
 * as an extra rung between `permission_scopes` and `destructive` with no
 * parent counterpart -- the pre-existing registration behaviour of this port
 * (the array is filtered to strings by {@link readTool} before it gets here).
 * So `scopes: ['read'], destructive: true` yields `read` here where the
 * parent, which has no such field, yields `delete`.
 */
function operationScopes(tool: MCPTool): readonly string[] {
  const explicit = tool.metadata?.permission_scopes;
  if (Array.isArray(explicit) && explicit.length > 0) return explicit.map(scopeText);
  if (tool.scopes !== undefined && tool.scopes.length > 0) return [...tool.scopes];
  if (tool.metadata?.destructive === true) return ['delete'];
  if (tool.metadata?.read_only === true) return ['read'];
  return ['execute'];
}

/**
 * Registration metadata for one MCP tool.
 *
 * The descriptor's own metadata is copied first and the fields a permission
 * decision reads are written after it, so a server cannot claim connector
 * scopes it did not declare through `required_scopes`. `connector` is copied
 * from the descriptor, exactly as the parent reads it back off the registered
 * definition ((parent) connector.py L346-352, L876-879).
 */
function mcpToolMetadata(server: string, tool: MCPTool): Readonly<Record<string, unknown>> {
  return {
    ...tool.metadata,
    connector_scopes: stringList(tool.metadata?.required_scopes),
    mcp: true,
    server,
    tool: tool.name,
    ref: mcpToolRef(server, tool.name),
  };
}

/**
 * The policy request for an MCP call, carrying the parent's `_policy_metadata`
 * fields ((parent) connector.py L876-879).
 *
 * Ref, permission scopes, connector and connector scopes are computed exactly
 * as {@link mcpToolDefinitions} computes them, so an approval recorded for the
 * registered tool covers this nested checkpoint too.
 */
function mcpPolicyRequest(
  server: MCPServerSpec,
  tool: MCPTool,
  arguments_: Readonly<Record<string, unknown>>,
): PolicyRequest {
  const metadata = mcpToolMetadata(server.name, tool);
  const connectorScopes = stringList(metadata.connector_scopes);
  return {
    checkpoint: 'before_mcp_call',
    action: mcpToolRef(server.name, tool.name),
    arguments: { ...arguments_ },
    metadata: {
      ...metadata,
      server_label: server.name,
      name: tool.name,
      transport: server.transport,
      scopes: connectorScopes,
      permission_scopes: operationScopes(tool),
      connector: metadata.connector ?? null,
      tool_ref: metadata.ref,
    },
  };
}

/**
 * Total, order-preserving scope list. A non-string member is kept in a stable
 * textual form rather than dropped, so an unexpected member still fails a
 * subset check instead of disappearing from it.
 */
function stringList(value: unknown): readonly string[] {
  if (Array.isArray(value)) return value.map(scopeText);
  return value === undefined || value === null || value === '' ? [] : [scopeText(value)];
}

function scopeText(value: unknown): string {
  return typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
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

function hashValue(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
import { createHash } from 'node:crypto';
import { inspect } from 'node:util';
