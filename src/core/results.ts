import type { Artifact } from './artifacts.js';
import type { AgentEvent } from './events.js';
import type { RunItem } from './items.js';
import type { SessionRef } from './sessions.js';
import type { ProviderState } from './state.js';
import type { ModelUsage } from './usage.js';

export type OutputStrategy =
  | 'provider_native'
  | 'finalizer_tool'
  | 'posthoc_parse'
  | 'posthoc_parse_with_retry';
export type OutputFallback = 'error' | 'finalizer_tool' | 'posthoc_parse';
export type AgentSessionResultStatus =
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'waiting_for_approval'
  | 'timeout';

export interface OutputSpec<TSchema = unknown> {
  readonly schema?: TSchema;
  readonly strategy: OutputStrategy;
  readonly max_validation_retries: number;
  readonly allow_partial: boolean;
  readonly name?: string;
  readonly description?: string;
  readonly strict: boolean;
  readonly fallback: OutputFallback;
}

export function structuredOutput<TSchema>(
  schema: TSchema,
  options: Partial<Omit<OutputSpec<TSchema>, 'schema'>> = {},
): OutputSpec<TSchema> {
  return {
    schema,
    strategy: options.strategy ?? 'posthoc_parse',
    max_validation_retries: options.max_validation_retries ?? 1,
    allow_partial: options.allow_partial ?? false,
    name: options.name,
    description: options.description,
    strict: options.strict ?? true,
    fallback: options.fallback ?? 'posthoc_parse',
  };
}

export interface ToolPayload<T = unknown> {
  readonly tool_name: string;
  readonly payload: T;
  readonly call_id?: string;
}

export interface AgentResult<T = string> {
  readonly output: T;
  readonly text: string;
  readonly events: readonly AgentEvent[];
  readonly items: readonly RunItem[];
  readonly artifacts: readonly Artifact[];
  readonly payloads: readonly ToolPayload[];
  readonly provider_state?: ProviderState;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface AgentResponseMessage {
  readonly content: string;
  readonly role: 'assistant';
  readonly index: number;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface AgentSessionResult<T = string> {
  readonly output: T;
  readonly text: string;
  readonly session_ref: SessionRef;
  readonly status: AgentSessionResultStatus;
  readonly events: readonly AgentEvent[];
  readonly messages: readonly AgentResponseMessage[];
  readonly artifacts: readonly Artifact[];
  readonly provider_state?: ProviderState;
  readonly usage?: ModelUsage;
  readonly trace: Readonly<Record<string, unknown>>;
  readonly metadata: Readonly<Record<string, unknown>>;
}
