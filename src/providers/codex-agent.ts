import type { ApprovalDecision } from '../core/approvals.js';
import type { ArtifactPage } from '../core/artifacts.js';
import type { AgentEvent } from '../core/events.js';
import type { AgentRef, AgentSession, InvocationRef, SessionRef } from '../core/sessions.js';
import type { AgentCapabilities, AgentProvider, AgentSpec, TaskSpec } from './agent.js';
import {
  CODEX_CANCEL_GRACE_MS,
  CODEX_DEFAULT_CAPABILITIES,
  CodexAppServerSessions,
  coerceCodexEvent,
  type CodexAppServerClient,
} from './codex-app-server.js';

export type {
  CodexAppServerClient,
  CodexAppServerConnectOptions,
  CodexAppServerConnection,
  CodexAppServerMessage,
  CodexAppServerNotification,
  CodexAppServerRequest,
  CodexAppServerResponse,
} from './codex-app-server.js';

/**
 * Codex app-server-backed `AgentProvider` (contract port of (parent)
 * src/blackbox/providers/agent_adapters/codex.py).
 *
 * Threads, turns, streamed items, native approvals, and interruption are kept
 * as provider-native state over the app-server session protocol, not
 * `codex exec`. The parent launches the `openai-codex` 0.147.0 bundled runtime
 * and lets it own the user's Codex/ChatGPT subscription credential; that SDK
 * version is the protocol version the parameter, notification, and
 * server-request shapes here were pinned against. This port owns no process
 * and carries no SDK dependency: the JSON-RPC transport is injected through
 * `CodexAppServerClient`, and the provider owns everything above it — the
 * pinned `thread/start` and `turn/start` parameters, the fail-closed answer to
 * server requests, the approval pause, the event-normalization table, and
 * `file_change` artifacts.
 *
 * The provider is subscription-only: it never reads `process.env`, refuses an
 * `OPENAI_API_KEY` in `AgentSpec.environment`, and forwards only the validated
 * spec environment to the transport. Blackbox local tools, hosted tools, and
 * MCP servers are not mapped and are refused before any transport is opened.
 */
export class CodexAgentProvider implements AgentProvider {
  readonly id = 'codex';
  static readonly aliases: readonly string[] = ['codex-app-server', 'codex_app_server'];
  private readonly sessions: CodexAppServerSessions;

  constructor(
    private readonly client: CodexAppServerClient,
    options: { readonly cancel_grace_ms?: number } = {},
  ) {
    this.sessions = new CodexAppServerSessions(
      client,
      this.id,
      options.cancel_grace_ms ?? CODEX_CANCEL_GRACE_MS,
    );
  }

  /**
   * The transport may advertise capabilities ((parent) L115-132), but two are
   * forced. The parent forces only `supports_package_permissions`: this
   * adapter forwards calls to a transport it does not control and cannot hold
   * a package boundary across them. Forcing `supports_resume` is this port's
   * addition, since the provider has no resume path.
   */
  capabilities(): AgentCapabilities {
    const advertised = this.client.capabilities?.();
    return {
      ...CODEX_DEFAULT_CAPABILITIES,
      ...advertised,
      supports_resume: false,
      supports_package_permissions: false,
    };
  }

  createAgent(spec: AgentSpec): Promise<AgentRef> {
    return this.sessions.createAgent(spec);
  }

  async startSession(agent: AgentRef | string, task: TaskSpec): Promise<AgentSession> {
    const started = await this.sessions.startSession(agent, task);
    return {
      provider: this.id,
      task: task.input,
      agent_id: started.agent_id,
      model: started.model,
      status: 'running',
      metadata: {
        agent_id: started.agent_id,
        task: task.input,
        thread_id: started.thread_id,
        ephemeral: started.ephemeral,
        provider_session_id: started.thread_id,
      },
      id: started.thread_id,
    };
  }

  async *streamEvents(
    session: SessionRef | AgentSession,
    options: { readonly after_event_id?: string } = {},
  ): AsyncIterable<AgentEvent> {
    for await (const raw of this.sessions.streamEvents(providerSessionId(session), options)) {
      yield coerceCodexEvent(raw, { provider: this.id, session_id: session.id });
    }
  }

  async sendMessage(session: SessionRef | AgentSession, message: string): Promise<InvocationRef> {
    const turnId = await this.sessions.sendMessage(providerSessionId(session), message);
    return {
      provider: this.id,
      session_id: session.id,
      id: turnId,
      metadata: { raw: { id: turnId, provider_session_id: providerSessionId(session) } },
    };
  }

  approve(approvalId: string, decision: ApprovalDecision): Promise<void> {
    return this.sessions.approve(approvalId, decision);
  }

  cancel(session: SessionRef | AgentSession): Promise<void> {
    return this.sessions.cancel(providerSessionId(session));
  }

  listArtifacts(
    session: SessionRef | AgentSession,
    options?: { readonly type?: string; readonly after?: string; readonly limit?: number },
  ): Promise<ArtifactPage> {
    return this.sessions.listArtifacts(providerSessionId(session), options);
  }

  /** Close every live app-server connection, then the transport itself. */
  close(): Promise<void> {
    return this.sessions.close();
  }
}

function providerSessionId(session: SessionRef | AgentSession): string {
  const value = session.metadata.provider_session_id;
  return typeof value === 'string' ? value : session.id;
}
