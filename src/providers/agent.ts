import type { ApprovalDecision } from '../core/approvals.js';
import type { ArtifactPage } from '../core/artifacts.js';
import type { AgentEvent } from '../core/events.js';
import type { AgentRef, AgentSession, InvocationRef, SessionRef } from '../core/sessions.js';

export interface AgentCapabilities {
  readonly supports_streaming_events: boolean;
  readonly supports_resume: boolean;
  readonly supports_follow_up: boolean;
  readonly supports_cancellation: boolean;
  readonly supports_artifacts: boolean;
  readonly supports_approvals: boolean;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface AgentSpec {
  readonly name: string;
  readonly instructions?: string;
  readonly model?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface TaskSpec {
  readonly input: string;
  readonly trace_id?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface AgentProvider {
  readonly id: string;
  capabilities(): AgentCapabilities;
  createAgent(spec: AgentSpec): Promise<AgentRef>;
  startSession(agent: AgentRef | string, task: TaskSpec): Promise<AgentSession>;
  streamEvents(
    session: SessionRef | AgentSession,
    options?: { readonly after_event_id?: string },
  ): AsyncIterable<AgentEvent>;
  sendMessage(
    session: SessionRef | AgentSession,
    message: string,
    options?: { readonly idempotency_key?: string },
  ): Promise<InvocationRef>;
  resume?(session: SessionRef | AgentSession): Promise<void>;
  approve(approvalId: string, decision: ApprovalDecision): Promise<void>;
  cancel(session: SessionRef | AgentSession): Promise<void>;
  listArtifacts(
    session: SessionRef | AgentSession,
    options?: {
      readonly type?: string;
      readonly after?: string;
      readonly limit?: number;
    },
  ): Promise<ArtifactPage>;
  close?(): void | Promise<void>;
}

export interface AgentWebhookDelivery {
  readonly provider: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  readonly received_at: string;
}

export interface AgentWebhookIngestResult {
  readonly accepted: boolean;
  readonly duplicate: boolean;
  readonly events: readonly AgentEvent[];
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface AgentWebhookProvider {
  ingestWebhook(delivery: AgentWebhookDelivery): Promise<AgentWebhookIngestResult>;
}
