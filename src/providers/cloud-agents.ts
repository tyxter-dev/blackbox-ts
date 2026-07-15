import { ProviderNotConfiguredError, UnsupportedFeatureError } from '../core/errors.js';
import type { AgentProvider, AgentCapabilities } from './agent.js';

export interface InjectedCloudAgentClient extends Omit<AgentProvider, 'id' | 'capabilities'> {
  close?(): void | Promise<void>;
}

abstract class InjectedCloudAgentProvider implements AgentProvider {
  abstract readonly id: string;

  constructor(
    protected readonly client: InjectedCloudAgentClient,
    private readonly configuredCapabilities: AgentCapabilities,
  ) {}

  capabilities(): AgentCapabilities {
    return this.configuredCapabilities;
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
  resume: NonNullable<AgentProvider['resume']> = async (session) => this.client.resume?.(session);
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
