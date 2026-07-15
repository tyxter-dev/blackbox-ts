import type { ToolRisk } from '../tools/types.js';

export const MCP_PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18'] as const;
export type MCPProtocolVersion = (typeof MCP_PROTOCOL_VERSIONS)[number];
export type MCPTransportKind = 'stdio' | 'http' | 'sse' | 'streamable_http';

export interface MCPServerSpec {
  readonly name: string;
  readonly transport: MCPTransportKind;
  readonly command?: string;
  readonly arguments?: readonly string[];
  readonly url?: string;
  readonly protocol_versions?: readonly MCPProtocolVersion[];
  readonly trusted?: boolean;
  readonly remote?: boolean;
  readonly allowed_tools?: readonly string[];
  readonly denied_tools?: readonly string[];
  readonly scopes?: readonly string[];
  readonly timeout_ms?: number;
  readonly max_output_bytes?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface MCPTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
  readonly risk?: ToolRisk;
  readonly scopes?: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface MCPToolResult {
  readonly content: readonly MCPContent[];
  readonly isError?: boolean;
  readonly structuredContent?: unknown;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export type MCPContent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly data: string; readonly mimeType: string }
  | { readonly type: 'resource'; readonly uri: string; readonly text?: string };

export interface MCPRequestContext {
  readonly headers: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly timeout_ms?: number;
}

export interface MCPTransport {
  request(method: string, params: unknown, context: MCPRequestContext): Promise<unknown>;
  close?(): void | Promise<void>;
}

export interface MCPTokenProvider {
  token(options?: {
    readonly force_refresh?: boolean;
    readonly scopes?: readonly string[];
  }): string | undefined | Promise<string | undefined>;
  cache_key?: string;
}

export interface MCPTrustDecision {
  readonly allowed: boolean;
  readonly reason?: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface MCPTrustPolicy {
  evaluate(server: MCPServerSpec, tool?: MCPTool): MCPTrustDecision | Promise<MCPTrustDecision>;
}

export type MCPRoute = 'local' | 'provider_native';
