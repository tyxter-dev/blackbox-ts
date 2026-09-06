import type { ApprovalDecision, ApprovalRequest } from '../core/approvals.js';
import { artifactPage, type Artifact, type ArtifactPage } from '../core/artifacts.js';
import {
  AgentRuntimeError,
  ConfigurationError,
  SessionBusyError,
  SessionNotFoundError,
  UnsupportedFeatureError,
} from '../core/errors.js';
import { AgentEventTypes, createAgentEvent, type AgentEvent } from '../core/events.js';
import { createRuntimeId } from '../core/ids.js';
import type { AgentRef } from '../core/sessions.js';
import type { AgentCapabilities, AgentSpec, TaskSpec } from './agent.js';
import type { WorkspaceSpec } from './base.js';

// Codex app-server protocol port ((parent) src/blackbox/providers/agent_adapters/codex.py).
//
// This module is deliberately not root-exported: it holds the JSON-RPC
// bookkeeping, the pinned parameter builders, and the event-normalization
// table that `CodexAgentProvider` runs over an injected transport. The public
// surface is re-exported from `./codex-agent.ts`.
//
// The parent adapter launches the `openai-codex` 0.147.0 bundled runtime as a
// child process. This port owns no process: the thread/turn parameter shapes,
// notification methods, server-request methods, and response shapes below are
// the ones the parent pinned against that SDK version, and the transport that
// speaks them is injected through `CodexAppServerClient`.

/** The `openai-codex` SDK version the parent pinned these protocol shapes against ((parent) L35). */
const CODEX_SDK_VERSION = '0.147.0';

/** How long `cancel` waits for `turn/completed` after `turn/interrupt` ((parent) L38). */
export const CODEX_CANCEL_GRACE_MS = 2000;

/** The only server requests the provider answers with a decision ((parent) L41-46). */
const APPROVAL_METHODS: ReadonlySet<string> = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
]);

/** A JSON-RPC request in either direction: the provider's own, or one the app-server sends. */
export interface CodexAppServerRequest {
  readonly id: string | number;
  readonly method: string;
  readonly params?: unknown;
}

/** A JSON-RPC notification in either direction (no `id`). */
export interface CodexAppServerNotification {
  readonly method: string;
  readonly params?: unknown;
}

/** A JSON-RPC response in either direction: the provider's answer to a server request, or the app-server's answer to the provider. */
export interface CodexAppServerResponse {
  readonly id: string | number;
  readonly result?: unknown;
  readonly error?: {
    readonly code: number;
    readonly message: string;
    readonly data?: unknown;
  };
}

export type CodexAppServerMessage =
  | CodexAppServerRequest
  | CodexAppServerNotification
  | CodexAppServerResponse;

export interface CodexAppServerConnectOptions {
  /**
   * The validated `AgentSpec.environment` for this thread: string keys and
   * values only, never `OPENAI_API_KEY`. The provider never reads
   * `process.env`, so this carries only what the spec supplied; a transport
   * that spawns a process and inherits its own environment must drop
   * `OPENAI_API_KEY` itself to stay subscription-only ((parent) L897-919).
   */
  readonly environment: Readonly<Record<string, string>>;
}

/**
 * One app-server JSON-RPC connection for one Codex thread.
 *
 * `messages` yields every inbound message (notifications, server requests,
 * and responses) until the connection ends; `close` must end that stream.
 */
export interface CodexAppServerConnection {
  send(message: CodexAppServerMessage): void | Promise<void>;
  readonly messages: AsyncIterable<CodexAppServerMessage>;
  close(): void | Promise<void>;
}

/**
 * Raw app-server transport boundary injected into `CodexAgentProvider`.
 *
 * The transport only moves JSON-RPC messages; the provider owns the thread
 * and turn requests, answers server requests, and normalizes notifications.
 * A transport may advertise capabilities, but `supports_package_permissions`
 * and `supports_resume` are forced false by the provider.
 */
export interface CodexAppServerClient {
  capabilities?(): Partial<AgentCapabilities>;
  connect(options: CodexAppServerConnectOptions): Promise<CodexAppServerConnection>;
  close?(): void | Promise<void>;
}

/** A buffered app-server event: a notification with an id, or a provider-synthesized `blackbox/*` event. */
export interface CodexRawEvent {
  readonly id: string;
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly raw_server_request?: CodexAppServerRequest;
}

export const CODEX_DEFAULT_CAPABILITIES: AgentCapabilities = {
  supports_streaming_events: true,
  supports_resume: false,
  supports_follow_up: true,
  supports_cancellation: true,
  supports_artifacts: true,
  supports_approvals: true,
  supports_package_permissions: false,
  metadata: { adapter: 'app_server', codex_sdk_version: CODEX_SDK_VERSION },
};

interface PendingApproval {
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly request_id: string | number;
}

interface PendingRequest {
  readonly resolve: (result: Record<string, unknown>) => void;
  readonly reject: (error: Error) => void;
}

interface CodexSessionRecord {
  readonly thread_id: string;
  readonly agent_id: string;
  readonly task: TaskSpec;
  readonly spec: AgentSpec;
  readonly connection: CodexConnection;
  current_turn_id?: string;
  readonly events: CodexRawEvent[];
  readonly waiters: Set<() => void>;
  readonly approvals: Map<string, PendingApproval>;
  readonly artifacts: Artifact[];
  current_turn_start_index: number;
  closed: boolean;
}

/**
 * Thread, turn, approval, and artifact bookkeeping over an injected transport
 * ((parent) `CodexPythonSDKClient` L263-528, minus process ownership).
 */
export class CodexAppServerSessions {
  private readonly agents = new Map<string, AgentSpec>();
  private readonly sessions = new Map<string, CodexSessionRecord>();

  constructor(
    private readonly client: CodexAppServerClient,
    private readonly providerId: string,
    private readonly cancelGraceMs: number,
  ) {}

  async createAgent(spec: AgentSpec): Promise<AgentRef> {
    validateCodexAgentSpec(spec);
    const configured = spec.metadata?.id;
    const agentId =
      typeof configured === 'string' && configured !== '' ? configured : `codex_agent_${spec.name}`;
    this.agents.set(agentId, spec);
    return {
      provider: this.providerId,
      id: agentId,
      metadata: { instructions: spec.instructions, model: spec.model, raw: spec },
    };
  }

  async startSession(
    agent: AgentRef | string,
    task: TaskSpec,
  ): Promise<{
    readonly thread_id: string;
    readonly agent_id: string;
    readonly model?: string;
    readonly ephemeral: boolean;
  }> {
    const agentId = typeof agent === 'string' ? agent : agent.id;
    const spec = this.agents.get(agentId);
    if (spec === undefined) {
      throw new UnsupportedFeatureError('codex_agent', `Unknown Codex agent '${agentId}'.`);
    }
    // Everything derived from the specs is validated before any transport is
    // opened, so a bad spec fails without a connection to clean up.
    const environment = codexProcessEnvironment(spec.environment);
    const threadParams = codexThreadStartParams(spec, task);
    const transport = await this.client.connect({ environment });
    const connection = new CodexConnection(transport, this.providerId);
    try {
      await connection.start();
      const threadResult = await connection.request('thread/start', threadParams);
      const threadId = nestedString(threadResult, 'thread', 'id');
      if (threadId === undefined) {
        throw new AgentRuntimeError('Codex app-server returned no thread id.');
      }
      const record: CodexSessionRecord = {
        thread_id: threadId,
        agent_id: agentId,
        task,
        spec,
        connection,
        events: [],
        waiters: new Set(),
        approvals: new Map(),
        artifacts: [],
        current_turn_start_index: 0,
        closed: false,
      };
      connection.bind(record);
      connection.appendEvent({ method: 'blackbox/session/started', params: { threadId } });
      await this.startTurn(record, task.input, task);
      this.sessions.set(threadId, record);
      return {
        thread_id: threadId,
        agent_id: agentId,
        model: selectedModel(spec, task),
        ephemeral: ephemeral(task),
      };
    } catch (error) {
      await connection.close();
      throw error;
    }
  }

  /**
   * Stream the buffered raw events of the current turn ((parent) L356-385).
   *
   * Without a cursor the stream starts at the current turn's first event and
   * ends at that turn's `turn/completed`; with `after_event_id` it replays
   * from the buffer instead. The synthetic `blackbox/session/started` entry is
   * buffered before the first turn's start index, exactly as in the parent,
   * and no cursor reaches it: `streamEvents` never yields it (parent quirk
   * kept; a consumer sees the turn's `turn/started` first).
   */
  async *streamEvents(
    providerSessionId: string,
    options: { readonly after_event_id?: string } = {},
  ): AsyncGenerator<CodexRawEvent> {
    const session = this.resolve(providerSessionId);
    let cursor =
      options.after_event_id === undefined
        ? session.current_turn_start_index
        : cursorAfter(session.events, options.after_event_id);
    const targetTurnId = session.current_turn_id;
    while (true) {
      while (
        cursor >= session.events.length &&
        !session.closed &&
        !turnIsComplete(session.events, targetTurnId)
      ) {
        await waitForSession(session);
      }
      const events = session.events.slice(cursor);
      cursor = session.events.length;
      for (const event of events) {
        yield event;
        if (isTurnCompleted(event, targetTurnId)) return;
      }
      // Events appended while the consumer held the generator suspended (an
      // approval answered between pulls, an interrupt landing) are drained
      // before the turn's completion or the close ends the stream; the parent
      // returns here as soon as the turn is complete and can drop them.
      if (
        cursor >= session.events.length &&
        (session.closed || turnIsComplete(session.events, targetTurnId))
      ) {
        return;
      }
    }
  }

  /** Steer the active turn, or start a follow-up turn ((parent) L387-415). */
  async sendMessage(providerSessionId: string, message: string): Promise<string> {
    const session = this.resolve(providerSessionId);
    if (session.closed) {
      throw new SessionBusyError('Codex app-server session is closed.', {
        session_id: providerSessionId,
        provider: this.providerId,
        operation: 'send_message',
        safe_to_retry: false,
      });
    }
    let turnId: string | undefined;
    if (
      session.current_turn_id !== undefined &&
      !turnIsComplete(session.events, session.current_turn_id)
    ) {
      const result = await session.connection.request('turn/steer', {
        expectedTurnId: session.current_turn_id,
        input: [{ type: 'text', text: message }],
        threadId: session.thread_id,
      });
      turnId = firstString(result, 'turnId') ?? session.current_turn_id;
    } else {
      await this.startTurn(session, message, session.task);
      turnId = session.current_turn_id;
    }
    if (turnId === undefined) {
      throw new AgentRuntimeError('Codex app-server accepted a turn without a turn id.');
    }
    return turnId;
  }

  /** Answer the pending server request behind one approval ((parent) L417-426, L704-709). */
  async approve(approvalId: string, decision: ApprovalDecision): Promise<void> {
    for (const session of this.sessions.values()) {
      const pending = session.approvals.get(approvalId);
      if (pending === undefined) continue;
      session.approvals.delete(approvalId);
      await session.connection.respond({
        id: pending.request_id,
        result: { decision: decision.approved ? 'accept' : 'decline' },
      });
      return;
    }
    throw new UnsupportedFeatureError(
      'codex_approval',
      `Unknown Codex app-server approval request '${approvalId}'.`,
    );
  }

  /**
   * Interrupt the active turn, then close the connection ((parent) L428-456).
   *
   * The parent waits `CODEX_CANCEL_GRACE_SECONDS` for the interrupted turn to
   * complete and then terminates its child process with a second kill grace.
   * With an injected transport only the first grace applies: the wait for
   * `turn/completed` is honoured, and closing the transport is the client's
   * own shutdown.
   */
  async cancel(providerSessionId: string): Promise<void> {
    const session = this.resolve(providerSessionId);
    const turnId = session.current_turn_id;
    // A session the reader already failed has no live turn to interrupt and
    // its stream already ended on `blackbox/session/failed`: only the
    // transport shutdown is left.
    const settled = session.closed;
    if (!settled && turnId !== undefined && !turnIsComplete(session.events, turnId)) {
      await session.connection.request('turn/interrupt', {
        threadId: session.thread_id,
        turnId,
      });
      await waitForSessionUntil(
        session,
        () => turnIsComplete(session.events, turnId) || session.closed,
        this.cancelGraceMs,
      );
    }
    await session.connection.close();
    session.closed = true;
    notifySession(session);
    if (!settled && !turnIsComplete(session.events, turnId)) {
      session.connection.appendEvent({
        method: 'blackbox/session/cancelled',
        params: { threadId: session.thread_id, turnId },
      });
    }
  }

  async listArtifacts(
    providerSessionId: string,
    options: { readonly type?: string; readonly after?: string; readonly limit?: number } = {},
  ): Promise<ArtifactPage> {
    const session = this.resolve(providerSessionId);
    const limit = options.limit ?? 100;
    const start = artifactCursor(session.artifacts, options.after);
    const items = session.artifacts
      .slice(start)
      .filter((artifact) => options.type === undefined || artifact.type === options.type);
    const hasMore = items.length > limit;
    return artifactPage(items.slice(0, limit), {
      has_more: hasMore,
      next_cursor: hasMore && limit > 0 ? items[limit - 1]?.id : undefined,
    });
  }

  async close(): Promise<void> {
    for (const session of new Set(this.sessions.values())) {
      await session.connection.close();
      session.closed = true;
      notifySession(session);
    }
    await this.client.close?.();
  }

  private async startTurn(session: CodexSessionRecord, prompt: string, task: TaskSpec) {
    session.current_turn_start_index = session.events.length;
    const result = await session.connection.request(
      'turn/start',
      codexTurnStartParams(session.thread_id, prompt, session.spec, task),
    );
    const turnId = nestedString(result, 'turn', 'id');
    if (turnId === undefined) throw new AgentRuntimeError('Codex app-server returned no turn id.');
    session.current_turn_id = turnId;
  }

  private resolve(providerSessionId: string): CodexSessionRecord {
    const session = this.sessions.get(providerSessionId);
    if (session === undefined) {
      throw new SessionNotFoundError(
        `Codex app-server session '${providerSessionId}' is not active in this process.`,
        { session_id: providerSessionId, provider: this.providerId, safe_to_retry: false },
      );
    }
    return session;
  }
}

/**
 * One JSON-RPC connection: request correlation, server-request handling, and
 * notification buffering ((parent) `_CodexAppServerConnection` L531-782).
 */
class CodexConnection {
  private readonly pending = new Map<string, PendingRequest>();
  private session: CodexSessionRecord | undefined;
  /** No further writes: set by `close` and by a reader failure. */
  private closed = false;
  private transportClosed = false;
  private reader: Promise<void> | undefined;

  constructor(
    private readonly transport: CodexAppServerConnection,
    private readonly providerId: string,
  ) {}

  async start(): Promise<void> {
    if (this.reader !== undefined) return;
    this.reader = this.readMessages();
    // `version` is the parent-mirrored app-server client identity pin
    // ((parent) L561-571), not this package's version.
    await this.request('initialize', {
      clientInfo: { name: 'blackbox', title: 'Blackbox Codex AgentProvider', version: '0.2.0' },
    });
    await this.transport.send({ method: 'initialized', params: {} });
  }

  bind(session: CodexSessionRecord): void {
    this.session = session;
  }

  async request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.closed) throw new AgentRuntimeError('Codex app-server connection is closed.');
    const requestId = `blackbox_${crypto.randomUUID().replaceAll('-', '')}`;
    const response = new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
    });
    try {
      await this.transport.send({ id: requestId, method, params });
      return await response;
    } finally {
      this.pending.delete(requestId);
    }
  }

  respond(response: CodexAppServerResponse): void | Promise<void> {
    if (this.closed) throw new AgentRuntimeError('Codex app-server connection is closed.');
    return this.transport.send(response);
  }

  appendEvent(event: {
    readonly id?: string;
    readonly method: string;
    readonly params: Readonly<Record<string, unknown>>;
    readonly raw_server_request?: CodexAppServerRequest;
  }): void {
    const session = this.session;
    if (session === undefined) return;
    const stored: CodexRawEvent = { id: createRuntimeId('evt'), ...event };
    session.events.push(stored);
    recordCodexArtifact(session.artifacts, stored, session.thread_id);
    notifySession(session);
  }

  async close(): Promise<void> {
    if (this.transportClosed) return;
    this.transportClosed = true;
    this.closed = true;
    // A pending approval belongs to a server request the transport can no
    // longer be answered on; drop it so a later `approve` fails explicitly.
    this.session?.approvals.clear();
    await this.transport.close();
    const error = new AgentRuntimeError('Codex app-server connection closed.');
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }

  private async readMessages(): Promise<void> {
    try {
      for await (const raw of this.transport.messages) {
        if (!isRecord(raw)) {
          throw new AgentRuntimeError(
            `Codex app-server emitted a non-object message: ${JSON.stringify(raw)}`,
          );
        }
        if ('method' in raw && 'id' in raw) await this.handleServerRequest(raw);
        else if ('method' in raw) this.handleNotification(raw);
        else this.handleResponse(raw);
      }
      if (!this.closed) throw new AgentRuntimeError('Codex app-server closed its message stream.');
    } catch (error) {
      // A stream that ends or throws while this side is closing is the close
      // itself, not a failure of the session.
      if (!this.closed) this.fail(error);
    }
  }

  /**
   * Answer a server-initiated request ((parent) L660-709).
   *
   * Only the two approval methods become approval pauses; anything else is
   * refused on the wire with JSON-RPC `-32601` and never surfaces as an
   * approval. The parent ignores non-string request ids; this port answers
   * numeric ids too, since an unanswered request would stall the turn.
   */
  private async handleServerRequest(raw: Record<string, unknown>): Promise<void> {
    const method = raw.method;
    const requestId = raw.id;
    const params = raw.params;
    if (typeof method !== 'string') return;
    if (typeof requestId !== 'string' && typeof requestId !== 'number') return;
    if (!APPROVAL_METHODS.has(method) || !isRecord(params)) {
      await this.transport.send({
        error: {
          code: -32601,
          message: `Blackbox refuses unsupported Codex server request '${method}'.`,
        },
        id: requestId,
      });
      return;
    }
    const session = this.session;
    if (session === undefined) {
      await this.transport.send({
        error: { code: -32000, message: 'No Blackbox session is bound.' },
        id: requestId,
      });
      return;
    }
    const approvalId = codexApprovalId(params);
    if (session.approvals.has(approvalId)) {
      await this.transport.send({
        error: {
          code: -32000,
          message: `Blackbox already holds a pending approval '${approvalId}'.`,
        },
        id: requestId,
      });
      return;
    }
    const action = method.includes('commandExecution') ? 'command' : 'file_change';
    session.approvals.set(approvalId, { method, params, request_id: requestId });
    const request: ApprovalRequest = { id: approvalId, action, data: params };
    this.appendEvent({
      method: 'blackbox/approval/requested',
      params: { action, approvalId, request, threadId: session.thread_id },
      raw_server_request: { ...raw, id: requestId, method, params },
    });
  }

  private handleNotification(raw: Record<string, unknown>): void {
    const session = this.session;
    if (session === undefined) return;
    const method = raw.method;
    const params = raw.params;
    if (typeof method !== 'string' || !isRecord(params)) return;
    if (params.threadId !== session.thread_id) return;
    if (method === 'turn/completed') {
      const turn = params.turn;
      if (isRecord(turn) && turn.id === session.current_turn_id)
        session.current_turn_id = undefined;
    }
    this.appendEvent({ method, params });
  }

  private handleResponse(raw: Record<string, unknown>): void {
    const requestId = raw.id;
    if (typeof requestId !== 'string') return;
    const pending = this.pending.get(requestId);
    if (pending === undefined) return;
    this.pending.delete(requestId);
    const error = raw.error;
    if (isRecord(error)) {
      const message =
        typeof error.message === 'string' && error.message !== ''
          ? error.message
          : 'Codex app-server request failed.';
      pending.reject(new AgentRuntimeError(message, { cause: error }));
      return;
    }
    const result = raw.result;
    if (!isRecord(result)) {
      pending.reject(new AgentRuntimeError('Codex app-server returned a non-object result.'));
      return;
    }
    pending.resolve(result);
  }

  /**
   * Project a reader failure onto the session ((parent) `_fail` L747-764).
   *
   * The parent leaves its connection open here and relies on `_write` raising
   * on the dead pipe; with an injected transport that safety net is gone, so
   * the connection is marked closed for writes and its pending approvals are
   * dropped: `request`/`respond` fail explicitly instead of writing into a
   * transport nobody reads, and `cancel` skips the interrupt.
   */
  private fail(error: unknown): void {
    const failure =
      error instanceof AgentRuntimeError
        ? error
        : new AgentRuntimeError(error instanceof Error ? error.message : String(error), {
            cause: error,
          });
    this.closed = true;
    for (const request of this.pending.values()) request.reject(failure);
    this.pending.clear();
    const session = this.session;
    if (session === undefined) return;
    session.closed = true;
    session.approvals.clear();
    this.appendEvent({
      method: 'blackbox/session/failed',
      params: { error: failure.message, threadId: session.thread_id },
    });
  }
}

export function validateCodexAgentSpec(spec: AgentSpec): void {
  if (spec.tools !== undefined && spec.tools.length > 0) {
    throw new UnsupportedFeatureError(
      'codex_local_tools',
      'CodexAgentProvider does not map Blackbox local tools into Codex app-server. ' +
        "Use Codex's native workspace tools instead.",
    );
  }
  if (spec.hosted_tools !== undefined && spec.hosted_tools.length > 0) {
    throw new UnsupportedFeatureError(
      'codex_hosted_tools',
      'CodexAgentProvider does not map Blackbox hosted tools into Codex app-server.',
    );
  }
  if (spec.mcp_servers !== undefined && spec.mcp_servers.length > 0) {
    throw new UnsupportedFeatureError(
      'codex_mcp_servers',
      'CodexAgentProvider does not map MCPServerSpec values into Codex app-server yet.',
    );
  }
}

/** `thread/start` parameters ((parent) L801-819). */
export function codexThreadStartParams(spec: AgentSpec, task: TaskSpec): Record<string, unknown> {
  const params: Record<string, unknown> = {
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    ephemeral: ephemeral(task),
  };
  const model = selectedModel(spec, task);
  if (model !== undefined) params.model = model;
  if (spec.instructions !== undefined && spec.instructions !== '') {
    params.developerInstructions = spec.instructions;
  }
  const root = codexWorkspaceRoot(task.workspace);
  if (root !== undefined) params.cwd = root;
  const sandbox = sandboxMode(spec, task);
  if (sandbox !== undefined) params.sandbox = sandbox;
  return params;
}

/** `turn/start` parameters ((parent) L821-841). */
export function codexTurnStartParams(
  threadId: string,
  prompt: string,
  spec: AgentSpec,
  task: TaskSpec,
): Record<string, unknown> {
  const params: Record<string, unknown> = {
    input: [{ type: 'text', text: prompt }],
    threadId,
  };
  const model = selectedModel(spec, task);
  if (model !== undefined) params.model = model;
  const root = codexWorkspaceRoot(task.workspace);
  if (root !== undefined) params.cwd = root;
  const sandbox = sandboxPolicy(spec, task);
  if (sandbox !== undefined) params.sandboxPolicy = sandbox;
  return params;
}

/**
 * The environment forwarded to the transport for one thread ((parent) L897-919).
 *
 * The parent copies `os.environ`, drops any inherited `OPENAI_API_KEY`, and
 * overlays the spec's environment. This port owns no process and never reads
 * `process.env`: only the validated spec environment is forwarded, so an
 * inherited key cannot reach the transport through this provider. A supplied
 * `OPENAI_API_KEY` is refused outright so a turn cannot silently switch from
 * the native subscription credential to API-key billing.
 */
export function codexProcessEnvironment(
  environment: Readonly<Record<string, unknown>> | undefined,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment ?? {})) {
    if (typeof value !== 'string') {
      throw new ConfigurationError('Codex AgentSpec.environment keys and values must be strings.');
    }
    if (key === 'OPENAI_API_KEY') {
      throw new UnsupportedFeatureError(
        'codex_openai_api_key',
        'CodexAgentProvider is subscription-only and does not accept OPENAI_API_KEY.',
      );
    }
    result[key] = value;
  }
  return result;
}

/**
 * The thread's working directory: `metadata.root` on any workspace spec, or
 * the `ref` of a local workspace, which is its root path in this port.
 */
export function codexWorkspaceRoot(workspace: WorkspaceSpec | undefined): string | undefined {
  if (workspace === undefined) return undefined;
  const root = workspace.metadata?.root;
  if (typeof root === 'string') return root;
  return workspace.kind === 'local' && typeof workspace.ref === 'string'
    ? workspace.ref
    : undefined;
}

/** Normalize one buffered app-server event ((parent) `_coerce_event` L1020-1041). */
export function coerceCodexEvent(
  raw: unknown,
  options: { readonly provider: string; readonly session_id: string },
): AgentEvent {
  const data = isRecord(raw) ? raw : {};
  const methodValue = data.method ?? data.type;
  const method = typeof methodValue === 'string' ? methodValue : '';
  const params = isRecord(data.params) ? data.params : {};
  const item = params.item;
  const itemId =
    firstString(params, 'itemId', 'approvalId') ??
    (isRecord(item) ? firstString(item, 'id') : undefined);
  return createAgentEvent({
    id: firstString(data, 'id') ?? createRuntimeId('evt'),
    type: codexEventType(method, params),
    provider: options.provider,
    session_id: options.session_id,
    item_id: itemId,
    data: { method, ...params },
    raw,
  });
}

/**
 * The app-server method → event type table ((parent) `_event_type` L1044-1097).
 * Unknown methods project to `CLOUD_AGENT_LOG`, which carries no authority
 * over session state.
 */
export function codexEventType(method: string, params: Readonly<Record<string, unknown>>): string {
  switch (method) {
    case 'blackbox/session/started':
      return AgentEventTypes.SESSION_STARTED;
    case 'blackbox/session/cancelled':
      return AgentEventTypes.SESSION_CANCELLED;
    case 'blackbox/session/failed':
      return AgentEventTypes.SESSION_FAILED;
    case 'blackbox/approval/requested':
      return AgentEventTypes.APPROVAL_REQUESTED;
    case 'turn/started':
      return AgentEventTypes.MODEL_REQUEST_STARTED;
    case 'turn/completed': {
      const turn = params.turn;
      const status = isRecord(turn) ? turn.status : undefined;
      if (status === 'interrupted') return AgentEventTypes.SESSION_CANCELLED;
      if (status === 'failed') return AgentEventTypes.SESSION_FAILED;
      return AgentEventTypes.SESSION_COMPLETED;
    }
    case 'item/agentMessage/delta':
      return AgentEventTypes.MODEL_TEXT_DELTA;
    case 'item/reasoning/textDelta':
    case 'item/reasoning/summaryTextDelta':
      return AgentEventTypes.MODEL_REASONING_DELTA;
    case 'item/commandExecution/outputDelta':
      return AgentEventTypes.WORKSPACE_COMMAND_OUTPUT;
    case 'item/fileChange/outputDelta':
    case 'item/fileChange/patchUpdated':
    case 'turn/diff/updated':
      return AgentEventTypes.WORKSPACE_FILE_CHANGED;
    case 'item/mcpToolCall/progress':
      return AgentEventTypes.MCP_CALL_STARTED;
    case 'item/started': {
      const itemType = codexItemType(params);
      if (itemType === 'commandExecution') return AgentEventTypes.WORKSPACE_COMMAND_STARTED;
      if (itemType === 'mcpToolCall') return AgentEventTypes.MCP_CALL_STARTED;
      if (itemType === 'webSearch' || itemType === 'dynamicToolCall') {
        return AgentEventTypes.HOSTED_TOOL_CALL_STARTED;
      }
      if (itemType === 'agentMessage') return AgentEventTypes.AGENT_RESPONSE_MESSAGE_CREATED;
      return AgentEventTypes.MODEL_ITEM_CREATED;
    }
    case 'item/completed': {
      const itemType = codexItemType(params);
      if (itemType === 'commandExecution') return AgentEventTypes.WORKSPACE_COMMAND_COMPLETED;
      if (itemType === 'fileChange') return AgentEventTypes.WORKSPACE_FILE_CHANGED;
      if (itemType === 'mcpToolCall') return AgentEventTypes.MCP_CALL_COMPLETED;
      if (itemType === 'webSearch' || itemType === 'dynamicToolCall') {
        return AgentEventTypes.HOSTED_TOOL_CALL_COMPLETED;
      }
      if (itemType === 'agentMessage') return AgentEventTypes.AGENT_RESPONSE_MESSAGE_CREATED;
      return AgentEventTypes.MODEL_ITEM_COMPLETED;
    }
    default:
      return AgentEventTypes.CLOUD_AGENT_LOG;
  }
}

/**
 * Record one `file_change` artifact per completed `fileChange` item, deduped
 * by item id, with the raw event preserved ((parent) L1137-1157).
 */
export function recordCodexArtifact(
  artifacts: Artifact[],
  event: CodexRawEvent,
  threadId: string,
): void {
  if (event.method !== 'item/completed') return;
  const params = event.params;
  if (codexItemType(params) !== 'fileChange') return;
  const item = params.item;
  if (!isRecord(item)) return;
  const itemId = firstString(item, 'id') ?? firstString(params, 'itemId') ?? createRuntimeId('art');
  if (artifacts.some((artifact) => artifact.id === itemId)) return;
  artifacts.push({
    id: itemId,
    type: 'file_change',
    name: firstString(item, 'path') ?? itemId,
    data: item,
    metadata: { raw: event, thread_id: threadId },
  });
}

function codexItemType(params: Readonly<Record<string, unknown>>): string | undefined {
  const item = params.item;
  return isRecord(item) ? firstString(item, 'type') : undefined;
}

function codexApprovalId(params: Readonly<Record<string, unknown>>): string {
  const value = firstString(params, 'approvalId', 'itemId', 'callId');
  return `codex_approval_${value ?? crypto.randomUUID().replaceAll('-', '')}`;
}

function selectedModel(spec: AgentSpec, task: TaskSpec): string | undefined {
  return task.model ?? spec.model;
}

/** `TaskSpec.metadata.ephemeral` stands in for the parent's `TaskSpec.extra['ephemeral']`. */
function ephemeral(task: TaskSpec): boolean {
  const value = task.metadata?.ephemeral ?? true;
  if (typeof value !== 'boolean') {
    throw new ConfigurationError(
      'TaskSpec.metadata.ephemeral must be a boolean for CodexAgentProvider.',
    );
  }
  return value;
}

const SANDBOX_MODES: Readonly<Record<string, string>> = {
  'read-only': 'read-only',
  'workspace-write': 'workspace-write',
  'full-access': 'danger-full-access',
};

const SANDBOX_POLICIES: Readonly<Record<string, { readonly type: string }>> = {
  'read-only': { type: 'readOnly' },
  'workspace-write': { type: 'workspaceWrite' },
  'full-access': { type: 'dangerFullAccess' },
};

function sandboxMode(spec: AgentSpec, task: TaskSpec): string | undefined {
  const value = codexOption('sandbox', spec, task);
  if (value === undefined) return undefined;
  const mode = SANDBOX_MODES[value];
  if (mode === undefined) throw invalidSandbox();
  return mode;
}

function sandboxPolicy(spec: AgentSpec, task: TaskSpec): { readonly type: string } | undefined {
  const value = codexOption('sandbox', spec, task);
  if (value === undefined) return undefined;
  const policy = SANDBOX_POLICIES[value];
  if (policy === undefined) throw invalidSandbox();
  return policy;
}

function invalidSandbox(): ConfigurationError {
  return new ConfigurationError(
    "Codex sandbox must be 'read-only', 'workspace-write', or 'full-access'.",
  );
}

/**
 * A Codex option read from `TaskSpec.metadata` then `AgentSpec.metadata`,
 * standing in for the parent's `task.extra` and `spec.permissions`.
 */
function codexOption(name: string, spec: AgentSpec, task: TaskSpec): string | undefined {
  const value = task.metadata?.[name] ?? spec.metadata?.[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new ConfigurationError(`Codex option '${name}' must be a string.`);
  }
  return value;
}

function cursorAfter(events: readonly CodexRawEvent[], afterEventId: string): number {
  const index = events.findIndex((event) => event.id === afterEventId);
  return index < 0 ? events.length : index + 1;
}

function artifactCursor(artifacts: readonly Artifact[], after: string | undefined): number {
  if (after === undefined) return 0;
  const index = artifacts.findIndex((artifact) => artifact.id === after);
  return index < 0 ? artifacts.length : index + 1;
}

function turnIsComplete(events: readonly CodexRawEvent[], turnId: string | undefined): boolean {
  return events.some((event) => isTurnCompleted(event, turnId));
}

function isTurnCompleted(event: CodexRawEvent, turnId: string | undefined): boolean {
  if (event.method !== 'turn/completed') return false;
  const turn = event.params.turn;
  if (!isRecord(turn)) return false;
  return turnId === undefined || turn.id === turnId;
}

function waitForSession(session: CodexSessionRecord): Promise<void> {
  return new Promise((resolve) => session.waiters.add(resolve));
}

async function waitForSessionUntil(
  session: CodexSessionRecord,
  condition: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, remaining);
    });
    await Promise.race([waitForSession(session), expired]);
    clearTimeout(timer);
  }
}

function notifySession(session: CodexSessionRecord): void {
  for (const resolve of session.waiters) resolve();
  session.waiters.clear();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function firstString(
  data: Readonly<Record<string, unknown>>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

function nestedString(
  data: Readonly<Record<string, unknown>>,
  ...keys: string[]
): string | undefined {
  let value: unknown = data;
  for (const key of keys) {
    if (!isRecord(value)) return undefined;
    value = value[key];
  }
  return typeof value === 'string' ? value : undefined;
}
