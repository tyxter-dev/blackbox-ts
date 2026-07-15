import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { MCPAuthenticationError, MCPError } from '../core/errors.js';
import type { MCPRequestContext, MCPTransport } from './types.js';

interface JsonRpcResponse {
  readonly jsonrpc: '2.0';
  readonly id: number;
  readonly result?: unknown;
  readonly error?: { readonly code?: number; readonly message?: string; readonly data?: unknown };
}

export class FetchMCPTransport implements MCPTransport {
  private requestId = 0;

  constructor(
    readonly url: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async request(method: string, params: unknown, context: MCPRequestContext): Promise<unknown> {
    const controller = new AbortController();
    const abort = () => controller.abort(context.signal?.reason);
    context.signal?.addEventListener('abort', abort, { once: true });
    const timeout =
      context.timeout_ms === undefined
        ? undefined
        : setTimeout(
            () => controller.abort(new Error('MCP request timed out.')),
            context.timeout_ms,
          );
    try {
      const id = ++this.requestId;
      const response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: {
          Accept: 'application/json, text/event-stream',
          'Content-Type': 'application/json',
          ...context.headers,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: controller.signal,
      });
      if (response.status === 401 || response.status === 403) {
        throw new MCPAuthenticationError(`MCP endpoint rejected authentication.`, {
          status_code: response.status,
          www_authenticate: response.headers.get('www-authenticate') ?? undefined,
        });
      }
      if (!response.ok) {
        throw new MCPError(`MCP HTTP request failed with status ${response.status}.`, {
          code: 'mcp_transport_error',
        });
      }
      const contentType = response.headers.get('content-type') ?? '';
      const payload = contentType.includes('text/event-stream')
        ? parseEventStream(await response.text())
        : ((await response.json()) as unknown);
      return readJsonRpcResult(payload, id);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      context.signal?.removeEventListener('abort', abort);
    }
  }
}

export class StdioMCPTransport implements MCPTransport {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<
    number,
    { readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void }
  >();
  private requestId = 0;

  constructor(command: string, arguments_: readonly string[] = []) {
    this.child = spawn(command, arguments_, { shell: false, windowsHide: true });
    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', (line) => this.handleLine(line));
    this.child.once('error', (cause) => this.rejectAll(cause));
    this.child.once('exit', (code) => {
      this.rejectAll(
        new MCPError(`MCP stdio process exited with code ${String(code)}.`, {
          code: 'mcp_transport_closed',
        }),
      );
    });
  }

  request(method: string, params: unknown, context: MCPRequestContext): Promise<unknown> {
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finishReject = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        this.pending.delete(id);
        reject(error);
      };
      const abort = () =>
        finishReject(
          context.signal?.reason instanceof Error
            ? context.signal.reason
            : new MCPError('MCP stdio request was cancelled.', { code: 'mcp_cancelled' }),
        );
      const timeout =
        context.timeout_ms === undefined
          ? undefined
          : setTimeout(
              () =>
                finishReject(new MCPError('MCP stdio request timed out.', { code: 'mcp_timeout' })),
              context.timeout_ms,
            );
      const cleanup = () => {
        if (timeout !== undefined) clearTimeout(timeout);
        context.signal?.removeEventListener('abort', abort);
      };
      this.pending.set(id, {
        resolve: (value) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(value);
        },
        reject: finishReject,
      });
      context.signal?.addEventListener('abort', abort, { once: true });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  close(): void {
    this.child.kill();
  }

  private handleLine(line: string): void {
    let response: JsonRpcResponse;
    try {
      response = JSON.parse(line) as JsonRpcResponse;
    } catch {
      return;
    }
    if (typeof response.id !== 'number') return;
    const pending = this.pending.get(response.id);
    if (pending === undefined) return;
    this.pending.delete(response.id);
    if (response.error !== undefined) pending.reject(jsonRpcError(response.error));
    else pending.resolve(response.result);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

function parseEventStream(body: string): unknown {
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (data && data !== '[DONE]') return JSON.parse(data) as unknown;
  }
  throw new MCPError('MCP event stream contained no response.', { code: 'mcp_invalid_response' });
}

function readJsonRpcResult(value: unknown, expectedId: number): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MCPError('MCP JSON-RPC response must be an object.', {
      code: 'mcp_invalid_response',
    });
  }
  const response = value as Partial<JsonRpcResponse>;
  if (response.id !== expectedId) {
    throw new MCPError('MCP JSON-RPC response id did not match the request.', {
      code: 'mcp_invalid_response',
    });
  }
  if (response.error !== undefined) throw jsonRpcError(response.error);
  return response.result;
}

function jsonRpcError(error: NonNullable<JsonRpcResponse['error']>): MCPError {
  return new MCPError(error.message ?? 'MCP JSON-RPC request failed.', {
    code: error.code === -32601 ? 'mcp_method_not_found' : 'mcp_remote_error',
    cause: error.data,
  });
}
