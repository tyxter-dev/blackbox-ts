import type {
  AgentCapabilities,
  CodexAppServerClient,
  CodexAppServerConnectOptions,
  CodexAppServerConnection,
  CodexAppServerMessage,
  CodexAppServerNotification,
  CodexAppServerRequest,
  CodexAppServerResponse,
} from '../../src/index.js';

export interface FakeCodexAppServerClientOptions {
  /**
   * Messages the app-server emits after the first `turn/start`, in order. A
   * server request (a message with `id` and `method`) pauses the script until
   * the provider answers it, exactly as a real approval blocks the turn.
   */
  readonly events?: readonly CodexAppServerMessage[];
  /** Messages emitted after every later `turn/start` (default: started + completed for that turn). */
  readonly follow_up_events?: (turnId: string) => readonly CodexAppServerMessage[];
  readonly thread_id?: string;
  /** Advertised through `capabilities()` when set. */
  readonly capabilities?: Partial<AgentCapabilities>;
  /** Whether `turn/interrupt` is followed by an interrupted `turn/completed` (default true). */
  readonly complete_on_interrupt?: boolean;
  /** Thrown from `send` whenever the provider answers a server request, to model a dead pipe. */
  readonly throw_on_response?: Error;
  /** Extra behaviour for one request method, replacing the default answer. */
  readonly respond?: (
    request: CodexAppServerRequest,
  ) => CodexAppServerResponse | readonly CodexAppServerMessage[] | undefined;
}

/**
 * Scriptable app-server transport for offline Codex provider tests: the port of
 * (parent) tests/fixtures/fake_codex_client.py plus the stdio stub script of
 * (parent) tests/runtime/test_codex_agent_provider.py, at the JSON-RPC boundary
 * the TypeScript provider owns.
 */
export class FakeCodexAppServerClient implements CodexAppServerClient {
  readonly requests: CodexAppServerRequest[] = [];
  readonly notifications: CodexAppServerNotification[] = [];
  readonly responses: CodexAppServerResponse[] = [];
  readonly connections: CodexAppServerConnectOptions[] = [];
  readonly open_connections: FakeCodexConnection[] = [];
  closed_connections = 0;
  closed = 0;
  capabilities?: () => Partial<AgentCapabilities>;

  constructor(private readonly options: FakeCodexAppServerClientOptions = {}) {
    if (options.capabilities !== undefined) {
      const advertised = options.capabilities;
      this.capabilities = () => advertised;
    }
  }

  async connect(options: CodexAppServerConnectOptions): Promise<CodexAppServerConnection> {
    this.connections.push(options);
    const connection = new FakeCodexConnection(this, this.options);
    this.open_connections.push(connection);
    return connection;
  }

  close(): void {
    this.closed += 1;
  }
}

export class FakeCodexConnection implements CodexAppServerConnection {
  readonly messages: AsyncIterable<CodexAppServerMessage>;
  private readonly queue: CodexAppServerMessage[] = [];
  private readonly waiters: Array<() => void> = [];
  private ended = false;
  private script: readonly CodexAppServerMessage[] = [];
  private scriptIndex = 0;
  private blockedOn: string | number | undefined;
  private turns = 0;
  private currentTurnId: string | undefined;

  constructor(
    private readonly client: FakeCodexAppServerClient,
    private readonly options: FakeCodexAppServerClientOptions,
  ) {
    this.messages = this.read();
  }

  send(message: CodexAppServerMessage): void {
    if ('method' in message && 'id' in message) {
      this.client.requests.push(message);
      this.answer(message);
      return;
    }
    if ('method' in message) {
      this.client.notifications.push(message);
      return;
    }
    if (this.options.throw_on_response !== undefined) throw this.options.throw_on_response;
    this.client.responses.push(message);
    if (this.blockedOn !== undefined && message.id === this.blockedOn) {
      this.blockedOn = undefined;
      this.playScript();
    }
  }

  /** Push a message from the "server" side, as a live app-server would between requests. */
  emit(message: CodexAppServerMessage): void {
    if (this.ended) return;
    this.queue.push(message);
    for (const wake of this.waiters.splice(0)) wake();
  }

  close(): void {
    if (this.ended) return;
    this.ended = true;
    this.client.closed_connections += 1;
    for (const wake of this.waiters.splice(0)) wake();
  }

  private answer(request: CodexAppServerRequest): void {
    const custom = this.options.respond?.(request);
    if (custom !== undefined) {
      const messages: readonly CodexAppServerMessage[] = Array.isArray(custom)
        ? (custom as readonly CodexAppServerMessage[])
        : [custom as CodexAppServerResponse];
      for (const message of messages) this.emit(message);
      return;
    }
    const threadId = this.options.thread_id ?? 'thread_1';
    switch (request.method) {
      case 'initialize':
        this.emit({ id: request.id, result: {} });
        return;
      case 'thread/start':
        this.emit({ id: request.id, result: { thread: { id: threadId } } });
        return;
      case 'turn/start': {
        this.turns += 1;
        const turnId = `turn_${this.turns}`;
        this.currentTurnId = turnId;
        this.emit({ id: request.id, result: { turn: { id: turnId } } });
        const script =
          this.turns === 1
            ? (this.options.events ?? [])
            : (this.options.follow_up_events?.(turnId) ?? [
                { method: 'turn/started', params: { threadId, turn: { id: turnId } } },
                {
                  method: 'turn/completed',
                  params: { threadId, turn: { id: turnId, status: 'completed' } },
                },
              ]);
        this.script = script;
        this.scriptIndex = 0;
        this.playScript();
        return;
      }
      case 'turn/steer':
        this.emit({ id: request.id, result: { turnId: this.currentTurnId } });
        return;
      case 'turn/interrupt': {
        this.emit({ id: request.id, result: {} });
        const params = request.params as { readonly turnId?: string } | undefined;
        if (this.options.complete_on_interrupt ?? true) {
          this.emit({
            method: 'turn/completed',
            params: { threadId, turn: { id: params?.turnId, status: 'interrupted' } },
          });
        }
        return;
      }
      default:
        this.emit({
          id: request.id,
          error: { code: -32601, message: `Fake app-server does not implement ${request.method}.` },
        });
    }
  }

  private playScript(): void {
    while (this.scriptIndex < this.script.length && this.blockedOn === undefined) {
      const message = this.script[this.scriptIndex];
      this.scriptIndex += 1;
      if (message === undefined) continue;
      this.emit(message);
      if ('method' in message && 'id' in message) this.blockedOn = message.id;
    }
  }

  private async *read(): AsyncGenerator<CodexAppServerMessage> {
    while (true) {
      while (this.queue.length > 0) {
        const message = this.queue.shift();
        if (message !== undefined) yield message;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }
}
