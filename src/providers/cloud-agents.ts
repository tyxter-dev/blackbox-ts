import {
  ConfigurationError,
  ProviderNotConfiguredError,
  UnsupportedFeatureError,
} from '../core/errors.js';
import type { AgentProvider, AgentCapabilities, TaskSpec } from './agent.js';

export interface InjectedCloudAgentClient extends Omit<AgentProvider, 'id' | 'capabilities'> {
  close?(): void | Promise<void>;
}

abstract class InjectedCloudAgentProvider implements AgentProvider {
  abstract readonly id: string;

  constructor(
    protected readonly client: InjectedCloudAgentClient,
    private readonly configuredCapabilities: AgentCapabilities,
  ) {}

  /**
   * The injected client cannot advertise package enforcement.
   *
   * This adapter forwards calls to a client it does not control, so it has no
   * way to hold a boundary across them; the flag is forced false whatever the
   * configured capabilities say ((parent) src/blackbox/providers/agent_adapters/
   * claude_code.py L152-157, openai_cloud.py L94-99).
   */
  capabilities(): AgentCapabilities {
    return {
      ...this.configuredCapabilities,
      supports_resume:
        this.configuredCapabilities.supports_resume && this.client.resume !== undefined,
      supports_package_permissions: false,
    };
  }

  async createAgent(spec: Parameters<AgentProvider['createAgent']>[0]) {
    const ref = await this.client.createAgent(spec);
    return { ...ref, provider: this.id };
  }
  async startSession(
    agent: Parameters<AgentProvider['startSession']>[0],
    task: Parameters<AgentProvider['startSession']>[1],
  ) {
    const session = await this.client.startSession(agent, task);
    return { ...session, provider: this.id };
  }
  async *streamEvents(
    session: Parameters<AgentProvider['streamEvents']>[0],
    options?: Parameters<AgentProvider['streamEvents']>[1],
  ) {
    for await (const event of this.client.streamEvents(session, options)) {
      yield { ...event, provider: this.id, session_id: event.session_id ?? session.id };
    }
  }
  async sendMessage(
    session: Parameters<AgentProvider['sendMessage']>[0],
    message: string,
    options?: Parameters<AgentProvider['sendMessage']>[2],
  ) {
    const invocation = await this.client.sendMessage(session, message, options);
    return { ...invocation, provider: this.id, session_id: session.id };
  }
  approve: AgentProvider['approve'] = (approvalId, decision) =>
    this.client.approve(approvalId, decision);
  cancel: AgentProvider['cancel'] = (session) => this.client.cancel(session);
  listArtifacts: AgentProvider['listArtifacts'] = (session, options) =>
    this.client.listArtifacts(session, options);
  resume: NonNullable<AgentProvider['resume']> = async (session) => {
    if (this.client.resume === undefined) throw new UnsupportedFeatureError('agent_resume');
    await this.client.resume(session);
  };
  close(): void | Promise<void> {
    return this.client.close?.();
  }
}

const CLOUD_CAPABILITIES: AgentCapabilities = {
  supports_streaming_events: true,
  supports_resume: true,
  supports_follow_up: true,
  supports_cancellation: true,
  supports_artifacts: true,
  supports_approvals: true,
  supports_package_permissions: false,
  metadata: { adapter: 'injected_client' },
};

export class OpenAICloudAgentProvider extends InjectedCloudAgentProvider {
  readonly id = 'openai-agent';
  constructor(client: InjectedCloudAgentClient) {
    super(client, CLOUD_CAPABILITIES);
  }
}

export type ClaudeCodeAuthMode = 'auto' | 'api_key' | 'subscription';
export type ResolvedClaudeCodeAuth = 'api_key' | 'subscription';

export interface ClaudeCodeAuthOptions {
  readonly auth?: ClaudeCodeAuthMode;
  readonly api_key?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly subscription_available?: () => boolean;
}

export function resolveClaudeCodeAuth(options: ClaudeCodeAuthOptions = {}): ResolvedClaudeCodeAuth {
  const mode = options.auth ?? 'auto';
  const env = options.env ?? process.env;
  if (mode === 'subscription') return 'subscription';
  if (options.api_key ?? env.ANTHROPIC_API_KEY) return 'api_key';
  if (mode === 'api_key') {
    throw new ProviderNotConfiguredError(
      'claude-code',
      "an api_key or ANTHROPIC_API_KEY when auth='api_key'",
    );
  }
  if (Boolean(env.CLAUDE_CODE_OAUTH_TOKEN) || options.subscription_available?.() === true) {
    return 'subscription';
  }
  throw new ProviderNotConfiguredError(
    'claude-code',
    'ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, or a logged-in Claude subscription',
  );
}

export class ClaudeCodeAgentProvider extends InjectedCloudAgentProvider {
  readonly id = 'claude-code';
  readonly auth: ClaudeCodeAuthMode;
  private readonly authOptions: ClaudeCodeAuthOptions;

  constructor(client: InjectedCloudAgentClient, options: ClaudeCodeAuthOptions = {}) {
    super(client, CLOUD_CAPABILITIES);
    this.auth = options.auth ?? 'auto';
    this.authOptions = options;
  }

  resolveAuth(): ResolvedClaudeCodeAuth {
    return resolveClaudeCodeAuth(this.authOptions);
  }

  /**
   * A `task_budget` on the task is admitted only in the parent's exact shape
   * before the injected client sees the task; an absent budget leaves the task
   * untouched. Follow-ups carry no budget channel (`sendMessage` options are
   * the idempotency key only), so only session start is gated.
   */
  override async startSession(
    agent: Parameters<AgentProvider['startSession']>[0],
    task: Parameters<AgentProvider['startSession']>[1],
  ) {
    assertClaudeTaskBudget(task);
    return super.startSession(agent, task);
  }
}

/** Largest admitted Claude Agent SDK task budget, in output tokens ((parent) claude_code.py L42). */
const MAX_CLAUDE_TASK_BUDGET_TOKENS = 1_000_000;

/**
 * The parent's `_normalize_task_budget` ((parent) src/blackbox/providers/
 * agent_adapters/claude_code.py L1001-1013), read from `task.metadata` --
 * the TS home of the parent's `task.extra`. The key's presence triggers the
 * check, so an explicit `task_budget: undefined` is rejected like the
 * parent's `None`. JavaScript has one number type, so `1.0` is the integer 1
 * where the parent would reject a float.
 */
function assertClaudeTaskBudget(task: TaskSpec): void {
  const metadata = task.metadata;
  if (metadata === undefined || !('task_budget' in metadata)) return;
  const budget = metadata.task_budget;
  const total =
    typeof budget === 'object' && budget !== null && !Array.isArray(budget)
      ? (budget as Record<string, unknown>).total
      : undefined;
  if (
    total === undefined ||
    Object.keys(budget as object).length !== 1 ||
    typeof total !== 'number' ||
    !Number.isInteger(total) ||
    total < 1 ||
    total > MAX_CLAUDE_TASK_BUDGET_TOKENS
  ) {
    throw new ConfigurationError(
      "task_budget must be exactly {'total': <positive int>} and no greater than " +
        `${MAX_CLAUDE_TASK_BUDGET_TOKENS}.`,
    );
  }
}

export class VertexAIAgentEngineProvider implements AgentProvider {
  readonly id = 'vertex-agent-engine';
  capabilities(): AgentCapabilities {
    return {
      supports_streaming_events: false,
      supports_resume: false,
      supports_follow_up: false,
      supports_cancellation: false,
      supports_artifacts: false,
      supports_approvals: false,
      supports_package_permissions: false,
      metadata: { status: 'partial_stub' },
    };
  }
  private unsupported(): never {
    throw new UnsupportedFeatureError(
      'vertex_agent_engine',
      'Vertex AI Agent Engine is contract-only in the Python parent.',
    );
  }
  async createAgent(): Promise<never> {
    return this.unsupported();
  }
  async startSession(): Promise<never> {
    return this.unsupported();
  }
  streamEvents(): AsyncIterable<never> {
    return this.unsupported();
  }
  async sendMessage(): Promise<never> {
    return this.unsupported();
  }
  async approve(): Promise<never> {
    return this.unsupported();
  }
  async cancel(): Promise<never> {
    return this.unsupported();
  }
  async listArtifacts(): Promise<never> {
    return this.unsupported();
  }
}
