import type { AgentEvent } from '../core/events.js';
import { AgentEventTypes, createAgentEvent } from '../core/events.js';
import type { ProviderState } from '../core/state.js';
import type { TokenUsage } from '../core/usage.js';
import type { AgentMessage } from '../core/content.js';
import type { Artifact } from '../core/artifacts.js';
import type { RunItem } from '../core/items.js';
import type { OutputSpec } from '../core/results.js';
import type { AgentCapabilityProfile } from '../core/capabilities.js';
import type { AgentModelId, AgentProviderId } from '../core/refs.js';
import { AgentRuntimeError, ConfigurationError } from '../core/errors.js';
import type { ToolDefinition } from '../tools/types.js';

export type { ToolDefinition } from '../tools/types.js';

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
  readonly verbosity?: 'low' | 'medium' | 'high' | (string & {});
  readonly state_mode?: 'stateless_replay' | 'provider_stateful' | (string & {});
  readonly modalities?: readonly string[];
  readonly tool_search?: unknown;
  readonly compaction?: unknown;
  readonly cache?: unknown;
  readonly background?: boolean;
  readonly store?: boolean;
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
  readonly output?: OutputSpec;
  readonly controls?: ModelRequestControls;
  readonly max_tokens?: number;
  readonly trace_id: string;
  readonly signal?: AbortSignal;
}

export interface TurnResult {
  readonly output_text: string;
  readonly provider_state?: ProviderState;
  readonly usage?: TokenUsage;
  readonly events?: readonly AgentEvent[];
  readonly items?: readonly RunItem[];
  readonly artifacts?: readonly Artifact[];
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly tokens_in?: number;
  readonly tokens_out?: number;
  readonly model?: AgentModelId;
  readonly provider?: AgentProviderId;
  readonly raw_response?: unknown;
}

export interface LLMCompletionInput {
  readonly system: string;
  readonly messages: ReadonlyArray<{
    readonly role: 'user' | 'assistant';
    readonly content: string;
  }>;
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
  readonly family?: string;
  readonly aliases?: readonly string[];
  readonly status?: ProviderModelStatus;
  readonly replacement_model?: string;
  readonly modalities?: readonly string[];
  readonly context_window?: number;
  readonly max_output_tokens?: number;
  readonly capabilities?: AgentCapabilityProfile['summary'];
  readonly source?: string;
  readonly catalog_version?: string;
  readonly retrieved_at?: string;
  readonly source_url?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export type ProviderModelStatus =
  | 'active'
  | 'preview'
  | 'deprecating'
  | 'deprecated'
  | 'retired'
  | 'unknown';

export interface ModelProvider {
  readonly id: AgentProviderId;
  readonly defaultModel?: AgentModelId;
  complete?(input: LLMCompletionInput): Promise<LLMCompletionResult>;
  capabilities(model?: AgentModelId): AgentCapabilityProfile;
  models?(): readonly ProviderModel[];
  streamTurn(request: TurnRequest): AsyncIterable<AgentEvent>;
  turn?(request: TurnRequest): Promise<TurnResult>;
  /** @deprecated Use streamTurn. */
  stream?(request: TurnRequest): AsyncIterable<AgentEvent>;
  close?(): void | Promise<void>;
}

export type AgentTurnRequest = TurnRequest;
export type AgentTurnResult = TurnResult;
export type AgentModelProvider = ModelProvider;

const MODEL_CONTROL_KEYS = [
  'max_output_tokens',
  'temperature',
  'top_p',
  'tool_choice',
  'parallel_tool_calls',
  'reasoning_effort',
  'verbosity',
  'state_mode',
  'modalities',
  'tool_search',
  'compaction',
  'cache',
  'background',
  'store',
  'include',
  'extra',
] as const satisfies readonly (keyof ModelRequestControls)[];

export function normalizeTurnRequest(request: TurnRequest): TurnRequest {
  if (request.controls === undefined) return request;

  const flattened: Record<string, unknown> = { ...request };
  for (const key of MODEL_CONTROL_KEYS) {
    const nested = request.controls[key];
    const topLevel = request[key];
    if (nested === undefined) continue;
    if (topLevel !== undefined && !sameControlValue(topLevel, nested)) {
      throw new ConfigurationError(
        `Turn request control '${key}' is set to conflicting top-level and nested values.`,
        { code: 'conflicting_request_control' },
      );
    }
    flattened[key] = nested;
  }
  return flattened as unknown as TurnRequest;
}

function sameControlValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

export async function complete(
  provider: ModelProvider,
  input: LLMCompletionInput,
): Promise<LLMCompletionResult> {
  const model = input.model ?? provider.defaultModel;
  if (!model) {
    throw new AgentRuntimeError(
      `Provider '${provider.id}' requires a model for completion compatibility.`,
    );
  }

  const request: TurnRequest = {
    model,
    input: input.messages,
    instructions: input.system,
    max_tokens: input.max_tokens,
    max_output_tokens: input.max_tokens,
    temperature: input.temperature,
    trace_id: input.trace_id,
  };
  const result =
    provider.turn === undefined
      ? await collectProviderStream(provider, request)
      : await provider.turn(request);

  return {
    content: result.output_text,
    tokens_in: result.usage?.input_tokens ?? result.tokens_in ?? 0,
    tokens_out: result.usage?.output_tokens ?? result.tokens_out ?? 0,
    model: result.model ?? model,
    provider: result.provider ?? provider.id,
    raw_response: result.raw_response,
  };
}

async function collectProviderStream(
  provider: ModelProvider,
  request: TurnRequest,
): Promise<TurnResult> {
  const events: AgentEvent[] = [];
  const deltas: string[] = [];
  let finalText: string | undefined;
  let usage: TokenUsage | undefined;
  let raw: unknown;
  for await (const event of provider.streamTurn(request)) {
    events.push(event);
    if (event.type === AgentEventTypes.MODEL_TEXT_DELTA) {
      const delta = event.data.delta;
      if (typeof delta === 'string') deltas.push(delta);
    }
    if (event.type === AgentEventTypes.MODEL_COMPLETED) {
      if (typeof event.data.output_text === 'string') finalText = event.data.output_text;
      if (isTokenUsage(event.data.usage)) usage = event.data.usage;
      raw = event.raw;
    }
  }
  return {
    output_text: finalText ?? deltas.join(''),
    usage,
    events,
    model: request.model,
    provider: provider.id,
    raw_response: raw,
  };
}

function isTokenUsage(value: unknown): value is TokenUsage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'input_tokens' in value &&
    typeof value.input_tokens === 'number' &&
    'output_tokens' in value &&
    typeof value.output_tokens === 'number'
  );
}

export function turnStartedEvent(provider: string, request: TurnRequest): AgentEvent {
  return createAgentEvent({
    type: AgentEventTypes.MODEL_REQUEST_STARTED,
    provider,
    model: request.model,
    trace_id: request.trace_id,
    data: { model: request.model },
  });
}

export function turnCompletedEvent(
  provider: string,
  request: TurnRequest,
  result: TurnResult,
): AgentEvent {
  return createAgentEvent({
    type: AgentEventTypes.MODEL_COMPLETED,
    provider,
    model: result.model ?? request.model,
    trace_id: request.trace_id,
    data: {
      output_text: result.output_text,
      output_text_length: result.output_text.length,
      usage: result.usage,
      provider_state: result.provider_state,
      items: result.items,
      artifacts: result.artifacts,
      metadata: result.metadata,
    },
    raw: result.raw_response,
  });
}

export async function* streamTurnFromResult(
  provider: string,
  request: TurnRequest,
  run: () => Promise<TurnResult>,
): AsyncIterable<AgentEvent> {
  const result = await run();
  if (result.events !== undefined && result.events.length > 0) {
    yield* result.events;
    return;
  }
  yield turnStartedEvent(provider, request);
  yield turnCompletedEvent(provider, request, result);
}
