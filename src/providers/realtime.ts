import type { ContentItem } from '../core/content.js';
import type { AgentEvent } from '../core/events.js';
import type { InvocationRef, SessionRef } from '../core/sessions.js';
import type { ProviderState } from '../core/state.js';
import type { HostedToolSpec, ToolDefinition } from './base.js';
import type { RuntimeConfig } from '../config/index.js';

export type RealtimeTransportKind = 'websocket' | 'webtransport' | 'webrtc';
export type RealtimeToolMode = 'manual' | 'auto' | 'disabled' | 'provider_managed';

export interface RealtimeCapabilities {
  readonly input_modalities: readonly string[];
  readonly output_modalities: readonly string[];
  readonly transports: readonly RealtimeTransportKind[];
  readonly supports_tools: boolean;
  readonly supports_resume: boolean;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface RealtimeSessionConfig {
  readonly instructions?: string;
  readonly input_modalities?: readonly string[];
  readonly output_modalities?: readonly string[];
  readonly voice?: string;
  readonly input_audio_format?: string;
  readonly output_audio_format?: string;
  readonly turn_detection?: 'server_vad' | 'semantic_vad' | 'manual' | (string & {});
  readonly interruption?: boolean;
  readonly transcription?: Readonly<Record<string, unknown>>;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly extra?: Readonly<Record<string, unknown>>;
}

export interface RealtimeConnectRequest {
  readonly model?: string;
  readonly runtime_config?: RuntimeConfig;
  readonly config?: RealtimeSessionConfig;
  readonly transport?: RealtimeTransportKind;
  readonly tools?: readonly ToolDefinition[];
  readonly hosted_tools?: readonly HostedToolSpec[];
  readonly tool_mode?: RealtimeToolMode;
  readonly provider_state?: ProviderState;
  readonly run_id?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly extra?: Readonly<Record<string, unknown>>;
}

export interface RealtimeSessionRef extends SessionRef {
  readonly model?: string;
  readonly transport: RealtimeTransportKind;
  readonly provider_session_id?: string;
  readonly provider_state?: ProviderState;
}

export interface RealtimeClientCommand {
  readonly type: string;
  readonly data?: Readonly<Record<string, unknown>>;
  readonly content?: ContentItem;
  readonly raw?: unknown;
}

export interface RealtimeProvider {
  readonly id: string;
  capabilities(model?: string): RealtimeCapabilities;
  connect(request: RealtimeConnectRequest): Promise<RealtimeSessionRef>;
  streamEvents(
    session: RealtimeSessionRef,
    options?: { readonly after_event_id?: string },
  ): AsyncIterable<AgentEvent>;
  send(session: RealtimeSessionRef, command: RealtimeClientCommand): Promise<InvocationRef>;
  updateSession(session: RealtimeSessionRef, config: RealtimeSessionConfig): Promise<void>;
  close(session?: RealtimeSessionRef): void | Promise<void>;
}
