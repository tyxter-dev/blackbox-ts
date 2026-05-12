import type { AgentEvent } from '../core/events.js';
import { AgentEventTypes } from '../core/events.js';
import type { ProviderState } from '../core/state.js';
import type { TokenUsage } from '../core/usage.js';
import type { AgentMessage } from '../core/content.js';
import type { AgentCapabilityProfile } from '../core/capabilities.js';
import type { AgentModelId, AgentProviderId } from '../core/refs.js';
import { AgentRuntimeError } from '../core/errors.js';

export interface ToolDefinition {
  readonly name: string;
  readonly description?: string;
  readonly input_schema?: unknown;
}

export interface HostedToolSpec {
  readonly type: string;
  readonly name?: string;
  readonly config?: Readonly<Record<string, unknown>>;
}

export interface MCPConnectionSpec {
  readonly id: string;
  readonly transport: 'stdio' | 'http' | 'sse' | 'provider_native';
  readonly server_label?: string;
  readonly config?: Readonly<Record<string, unknown>>;
}

export interface WorkspaceSpec {
  readonly id?: string;
  readonly kind: 'local' | 'git' | 'sandbox' | 'docker' | 'cloud';
  readonly ref?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface StructuredOutputFormat {
  readonly type: 'json_schema';
  readonly name: string;
  readonly schema: unknown;
  readonly strict?: boolean;
}

export interface TextOutputFormat {
  readonly type: 'text';
}

export type ResponseFormat = TextOutputFormat | StructuredOutputFormat;

export interface ModelRequestControls {
  readonly max_output_tokens?: number;
  readonly temperature?: number;
  readonly top_p?: number;
  readonly tool_choice?: 'auto' | 'none' | 'required' | (string & {});
  readonly parallel_tool_calls?: boolean;
  readonly reasoning_effort?: 'minimal' | 'low' | 'medium' | 'high' | (string & {});
  readonly include?: readonly string[];
  readonly extra?: Readonly<Record<string, unknown>>;
}

export interface TurnRequest extends ModelRequestControls {
  readonly model: AgentModelId;
  readonly input: string | readonly AgentMessage[];
  readonly instructions?: string;
  readonly tools?: readonly ToolDefinition[];
  readonly hosted_tools?: readonly HostedToolSpec[];
  readonly mcp_connections?: readonly MCPConnectionSpec[];
  readonly workspace?: WorkspaceSpec;
  readonly provider_state?: ProviderState;
  readonly response_format?: ResponseFormat;
  readonly max_tokens?: number;
  readonly trace_id: string;
}

export interface TurnResult {
  readonly output_text: string;
  readonly provider_state?: ProviderState;
  readonly usage?: TokenUsage;
  readonly events?: readonly AgentEvent[];
  readonly tokens_in?: number;
  readonly tokens_out?: number;
  readonly model?: AgentModelId;
  readonly provider?: AgentProviderId;
  readonly raw_response?: unknown;
}

export interface LLMCompletionInput {
  readonly system: string;
  readonly messages: ReadonlyArray<{ readonly role: 'user' | 'assistant'; readonly content: string }>;
  readonly model?: AgentModelId;
  readonly max_tokens?: number;
  readonly temperature?: number;
  readonly trace_id: string;
}

export interface LLMCompletionResult {
  readonly content: string;
  readonly tokens_in: number;
  readonly tokens_out: number;
  readonly model: AgentModelId;
  readonly provider?: AgentProviderId;
  readonly raw_response?: unknown;
}

export interface LLMProviderAdapter {
  complete(input: LLMCompletionInput): Promise<LLMCompletionResult>;
}

export interface ProviderModel {
  readonly provider: AgentProviderId;
  readonly id: AgentModelId;
  readonly display_name?: string;
  readonly aliases?: readonly string[];
  readonly status?: ProviderModelStatus;
  readonly context_window?: number;
  readonly max_output_tokens?: number;
  readonly capabilities?: AgentCapabilityProfile['summary'];
}

export type ProviderModelStatus = 'active' | 'preview' | 'deprecated' | 'unknown';

export interface ModelProvider extends LLMProviderAdapter {
  readonly id: AgentProviderId;
  readonly defaultModel?: AgentModelId;
  capabilities(model?: AgentModelId): AgentCapabilityProfile;
  models?(): readonly ProviderModel[];
  turn?(request: TurnRequest): Promise<TurnResult>;
  stream?(request: TurnRequest): AsyncIterable<AgentEvent>;
  close?(): void | Promise<void>;
}

export type AgentTurnRequest = TurnRequest;
export type AgentTurnResult = TurnResult;
export type AgentModelProvider = ModelProvider;

export async function complete(provider: ModelProvider, input: LLMCompletionInput): Promise<LLMCompletionResult> {
  if (!provider.turn) {
    return provider.complete(input);
  }

  const model = input.model ?? provider.defaultModel;
  if (!model) {
    throw new AgentRuntimeError(`Provider '${provider.id}' requires a model for completion compatibility.`);
  }

  const result = await provider.turn({
    model,
    input: input.messages,
    instructions: input.system,
    max_tokens: input.max_tokens,
    max_output_tokens: input.max_tokens,
    temperature: input.temperature,
    trace_id: input.trace_id,
  });

  return {
    content: result.output_text,
    tokens_in: result.usage?.input_tokens ?? result.tokens_in ?? 0,
    tokens_out: result.usage?.output_tokens ?? result.tokens_out ?? 0,
    model: result.model ?? model,
    provider: result.provider ?? provider.id,
    raw_response: result.raw_response,
  };
}

export function turnStartedEvent(provider: string, request: TurnRequest): AgentEvent {
  return {
    type: AgentEventTypes.MODEL_REQUEST_STARTED,
    provider,
    model: request.model,
    trace_id: request.trace_id,
    data: { model: request.model },
  };
}

export function turnCompletedEvent(provider: string, request: TurnRequest, result: TurnResult): AgentEvent {
  return {
    type: AgentEventTypes.MODEL_COMPLETED,
    provider,
    model: result.model ?? request.model,
    trace_id: request.trace_id,
    data: {
      output_text_length: result.output_text.length,
      usage: result.usage,
    },
    raw: result.raw_response,
  };
}
