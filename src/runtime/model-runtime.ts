import { assertTurnRequestCapabilities } from '../core/capabilities.js';
import { AgentEventTypes, type AgentEvent } from '../core/events.js';
import { createRuntimeId } from '../core/ids.js';
import type { RunItem } from '../core/items.js';
import type { ProviderState } from '../core/state.js';
import type { ModelUsage } from '../core/usage.js';
import type { Artifact } from '../core/artifacts.js';
import { ConfigurationError, UnsupportedFeatureError } from '../core/errors.js';
import { parseProviderModelRef } from '../core/refs.js';
import { activePermissions, validatePackageModelConfig } from '../core/tool-permissions.js';
import type { RuntimeConfig } from '../config/index.js';
import { normalizeTurnRequest, type TurnRequest, type TurnResult } from '../providers/base.js';
import { ProviderRegistry } from '../providers/registry.js';

export type ModelRunRequest = Omit<TurnRequest, 'model' | 'trace_id'> & {
  /** A canonical provider:model ref, a legacy provider/model ref, or a model with provider. */
  readonly model?: string;
  readonly provider?: string;
  readonly trace_id?: string;
  readonly config?: RuntimeConfig;
};

export class ModelRuntime {
  constructor(readonly registry: ProviderRegistry) {}

  async *stream(input: ModelRunRequest): AsyncIterable<AgentEvent> {
    const configured = input.config?.toValues({ surface: 'model' }) ?? {};
    const explicit = { ...input };
    delete explicit.config;
    const combined = { ...configured, ...withoutUndefined(explicit) } as ModelRunRequest;
    let { provider: providerHint, model: modelRef } = combined;
    if (modelRef === undefined && isQualifiedProviderRef(providerHint)) {
      modelRef = providerHint;
      providerHint = undefined;
    } else if (modelRef !== undefined && isQualifiedProviderRef(providerHint)) {
      providerHint = parseProviderModelRef(providerHint).provider;
    }
    if (modelRef === undefined) {
      throw new ConfigurationError('Model runtime requires a model or provider:model ref.', {
        code: 'model_required',
      });
    }
    const trace_id = combined.trace_id;
    const rest = { ...combined };
    delete rest.provider;
    delete rest.model;
    delete rest.trace_id;
    const resolved = this.registry.resolveModelProvider(modelRef, providerHint);
    const request = gatePackageModelConfig(
      normalizeTurnRequest({
        ...rest,
        model: resolved.model,
        trace_id: trace_id ?? crypto.randomUUID(),
      }),
    );
    const profile = resolved.provider.capabilities(resolved.model);
    assertTurnRequestCapabilities(resolved.provider_id, request, profile);

    const runId = createRuntimeId('run');
    let sequence = 0;
    for await (const event of resolved.provider.streamTurn(request)) {
      yield {
        ...event,
        run_id: event.run_id ?? runId,
        sequence: event.sequence ?? sequence,
        trace_id: event.trace_id ?? request.trace_id,
        provider: event.provider ?? resolved.provider_id,
        model: event.model ?? resolved.model,
      };
      sequence += 1;
    }
  }

  async run(input: ModelRunRequest): Promise<TurnResult> {
    const events: AgentEvent[] = [];
    const textDeltas: string[] = [];
    let finalText: string | undefined;
    let usage: ModelUsage | undefined;
    let providerState: ProviderState | undefined;
    let items: readonly RunItem[] | undefined;
    let artifacts: readonly Artifact[] | undefined;
    let metadata: Readonly<Record<string, unknown>> | undefined;
    let rawResponse: unknown;
    let model: string | undefined;
    let provider: string | undefined;

    for await (const event of this.stream(input)) {
      events.push(event);
      model = event.model ?? model;
      provider = event.provider ?? provider;
      if (event.raw !== undefined) rawResponse = event.raw;

      if (event.type === AgentEventTypes.MODEL_TEXT_DELTA) {
        const delta = readString(event.data, 'delta') ?? readString(event.data, 'text');
        if (delta !== undefined) textDeltas.push(delta);
      }
      if (event.type === AgentEventTypes.MODEL_COMPLETED) {
        finalText = readString(event.data, 'output_text') ?? finalText;
        usage = readUsage(event.data.usage) ?? usage;
        providerState = readProviderState(event.data.provider_state) ?? providerState;
        items = readArray<RunItem>(event.data.items) ?? items;
        artifacts = readArray<Artifact>(event.data.artifacts) ?? artifacts;
        metadata = readRecord(event.data.metadata) ?? metadata;
      }
    }

    return {
      output_text: finalText ?? textDeltas.join(''),
      provider_state: providerState,
      usage,
      events,
      items,
      artifacts,
      metadata,
      model,
      provider,
      raw_response: rawResponse,
    };
  }

  capabilities(ref: string, fallbackProvider?: string) {
    const resolved = this.registry.resolveModelProvider(ref, fallbackProvider);
    return resolved.provider.capabilities(resolved.model);
  }
}

/**
 * Re-validate one turn's model configuration against the active package
 * boundary, immediately before the capability check.
 *
 * This runs per turn rather than once per run: the agent loop re-enters this
 * method for every iteration, so a boundary entered around the run constrains
 * every turn it makes. With no boundary active the request object is returned
 * unchanged.
 */
function gatePackageModelConfig(request: TurnRequest): TurnRequest {
  if (activePermissions().length === 0) return request;
  if (toolSearchRequested(request.tool_search)) {
    // Provider-native tool search would let the model reach tools this process
    // never exposes, so no per-tool checkpoint can see them.
    throw new UnsupportedFeatureError(
      'allowlist_v1 cannot enforce provider-native ToolSearchControl.',
    );
  }
  const hostedTools = validatePackageModelConfig(request.hosted_tools ?? [], request.extra ?? {});
  return request.hosted_tools === undefined || hostedTools === request.hosted_tools
    ? request
    : { ...request, hosted_tools: hostedTools };
}

/** Mirror the parent's `tool_search is not None and tool_search.enabled`. */
function toolSearchRequested(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (typeof value === 'object' && !Array.isArray(value)) {
    const enabled = (value as { readonly enabled?: unknown }).enabled;
    return enabled === undefined || enabled !== false;
  }
  return true;
}

function isQualifiedProviderRef(value: string | undefined): value is string {
  return value !== undefined && (value.includes(':') || value.includes('/'));
}

function withoutUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, child]) => child !== undefined),
  ) as Partial<T>;
}

function readString(value: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const child = value[key];
  return typeof child === 'string' ? child : undefined;
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function readArray<T>(value: unknown): readonly T[] | undefined {
  return Array.isArray(value) ? (value as readonly T[]) : undefined;
}

function readUsage(value: unknown): ModelUsage | undefined {
  const usage = readRecord(value);
  return usage !== undefined && typeof usage.input_tokens === 'number'
    ? (usage as unknown as ModelUsage)
    : undefined;
}

function readProviderState(value: unknown): ProviderState | undefined {
  const state = readRecord(value);
  return state !== undefined && typeof state.provider === 'string'
    ? (state as unknown as ProviderState)
    : undefined;
}
