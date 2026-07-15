import type { AgentEvent } from '../core/events.js';
import { AgentEventTypes, createAgentEvent } from '../core/events.js';
import type { EventStore } from '../persistence/stores.js';
import type { EventSink } from './sinks.js';

export interface TraceSpan {
  readonly id: string;
  readonly parent_id?: string;
  readonly name: string;
  readonly started_at: string;
  readonly ended_at: string;
  readonly status: 'ok' | 'error';
  readonly event_ids: readonly string[];
  readonly attributes: Readonly<Record<string, unknown>>;
}

export interface ReconstructedTrace {
  readonly trace_id?: string;
  readonly run_id?: string;
  readonly spans: readonly TraceSpan[];
  readonly links: readonly { readonly trace_id: string; readonly span_id?: string }[];
}

export interface StandardMetrics {
  readonly latency_ms: number;
  readonly first_event_ms: number;
  readonly first_token_ms?: number;
  readonly retries: number;
  readonly validation_attempts: number;
  readonly cache_hits: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly provider_errors: number;
  readonly cost?: number;
}

export function reconstructTrace(events: readonly AgentEvent[]): ReconstructedTrace {
  if (events.length === 0) return { spans: [], links: [] };
  const rootId = events[0]?.span_id ?? `span:${events[0]?.run_id ?? events[0]?.id}`;
  const root = spanFromEvents(rootId, undefined, 'agent.run', events);
  const groups = new Map<string, AgentEvent[]>();
  for (const event of events) {
    const name = spanName(event.type);
    if (name === undefined) continue;
    const key = `${name}:${event.item_id ?? event.provider_request_id ?? 'default'}`;
    const group = groups.get(key) ?? [];
    group.push(event);
    groups.set(key, group);
  }
  const spans = [
    root,
    ...[...groups.entries()].map(([key, grouped]) =>
      spanFromEvents(key, rootId, spanName(grouped[0]!.type)!, grouped),
    ),
  ];
  const links = events.flatMap((event) => {
    const value = event.data.trace_link;
    return typeof value === 'object' &&
      value !== null &&
      'trace_id' in value &&
      typeof value.trace_id === 'string'
      ? [
          {
            trace_id: value.trace_id,
            span_id:
              'span_id' in value && typeof value.span_id === 'string' ? value.span_id : undefined,
          },
        ]
      : [];
  });
  return {
    trace_id: events.find((event) => event.trace_id)?.trace_id,
    run_id: events.find((event) => event.run_id)?.run_id,
    spans,
    links,
  };
}

export function extractStandardMetrics(events: readonly AgentEvent[]): StandardMetrics {
  const first = events[0];
  const last = events.at(-1);
  const started = first === undefined ? 0 : Date.parse(first.timestamp);
  const ended = last === undefined ? started : Date.parse(last.timestamp);
  const firstToken = events.find((event) => event.type === AgentEventTypes.MODEL_TEXT_DELTA);
  const completion = [...events]
    .reverse()
    .find((event) => event.type === AgentEventTypes.RUN_COMPLETED);
  const metadata = asRecord(completion?.data.metadata);
  const usage = asRecord(metadata.usage);
  return {
    latency_ms: Math.max(0, ended - started),
    first_event_ms: 0,
    first_token_ms:
      firstToken === undefined
        ? undefined
        : Math.max(0, Date.parse(firstToken.timestamp) - started),
    retries: events.filter((event) => event.type === AgentEventTypes.RETRY_STARTED).length,
    validation_attempts: readNumber(metadata.validation_attempts),
    cache_hits: events.filter((event) => event.type === AgentEventTypes.MCP_TOOLS_CACHE_HIT).length,
    input_tokens: readNumber(usage.input_tokens),
    output_tokens: readNumber(usage.output_tokens),
    provider_errors: events.filter((event) => event.type === AgentEventTypes.MODEL_FAILED).length,
    cost: typeof metadata.cost === 'number' ? metadata.cost : undefined,
  };
}

export interface OpenTelemetryExporter {
  export(spans: readonly TraceSpan[]): void | Promise<void>;
}

export class OpenTelemetryEventSink implements EventSink {
  private readonly events = new Map<string, AgentEvent[]>();
  constructor(private readonly exporter: OpenTelemetryExporter) {}
  async emit(event: AgentEvent): Promise<void> {
    const key = event.run_id ?? event.session_id ?? event.trace_id ?? 'unscoped';
    const events = this.events.get(key) ?? [];
    events.push(event);
    this.events.set(key, events);
    if (event.type === AgentEventTypes.RUN_COMPLETED || event.type === AgentEventTypes.RUN_FAILED) {
      await this.exporter.export(reconstructTrace(events).spans);
      this.events.delete(key);
    }
  }
}

export async function replayStoredRun(
  store: EventStore,
  runId: string,
): Promise<readonly AgentEvent[]> {
  return store.list({ run_id: runId });
}

export interface RunDiff {
  readonly added_types: readonly string[];
  readonly removed_types: readonly string[];
  readonly output_changed: boolean;
  readonly metric_delta: Readonly<Record<string, number>>;
}

export function diffRuns(left: readonly AgentEvent[], right: readonly AgentEvent[]): RunDiff {
  const leftTypes = new Set(left.map((event) => event.type));
  const rightTypes = new Set(right.map((event) => event.type));
  const leftMetrics = extractStandardMetrics(left);
  const rightMetrics = extractStandardMetrics(right);
  const leftOutput = [...left]
    .reverse()
    .find((event) => event.type === AgentEventTypes.RUN_COMPLETED)?.data.output;
  const rightOutput = [...right]
    .reverse()
    .find((event) => event.type === AgentEventTypes.RUN_COMPLETED)?.data.output;
  return {
    added_types: [...rightTypes].filter((type) => !leftTypes.has(type)),
    removed_types: [...leftTypes].filter((type) => !rightTypes.has(type)),
    output_changed: JSON.stringify(leftOutput) !== JSON.stringify(rightOutput),
    metric_delta: {
      latency_ms: rightMetrics.latency_ms - leftMetrics.latency_ms,
      input_tokens: rightMetrics.input_tokens - leftMetrics.input_tokens,
      output_tokens: rightMetrics.output_tokens - leftMetrics.output_tokens,
    },
  };
}

export interface Evaluator {
  readonly name: string;
  evaluate(events: readonly AgentEvent[]): unknown;
}

export async function evaluateRun(
  events: readonly AgentEvent[],
  evaluators: readonly Evaluator[],
  sink?: EventSink,
): Promise<Readonly<Record<string, unknown>>> {
  const results: Record<string, unknown> = {};
  for (const evaluator of evaluators) {
    await sink?.emit(
      createAgentEvent({
        type: AgentEventTypes.EVAL_STARTED,
        run_id: events[0]?.run_id,
        trace_id: events[0]?.trace_id,
        data: { evaluator: evaluator.name },
      }),
    );
    try {
      results[evaluator.name] = await evaluator.evaluate(events);
      await sink?.emit(
        createAgentEvent({
          type: AgentEventTypes.EVAL_COMPLETED,
          run_id: events[0]?.run_id,
          trace_id: events[0]?.trace_id,
          data: { evaluator: evaluator.name, result: results[evaluator.name] },
        }),
      );
    } catch (cause) {
      results[evaluator.name] = {
        error: cause instanceof Error ? cause.message : 'Evaluator failed.',
      };
      await sink?.emit(
        createAgentEvent({
          type: AgentEventTypes.EVAL_FAILED,
          run_id: events[0]?.run_id,
          trace_id: events[0]?.trace_id,
          data: { evaluator: evaluator.name, error: results[evaluator.name] },
        }),
      );
    }
  }
  return results;
}

function spanFromEvents(
  id: string,
  parentId: string | undefined,
  name: string,
  events: readonly AgentEvent[],
): TraceSpan {
  const first = events[0]!;
  const last = events.at(-1)!;
  return {
    id,
    parent_id: parentId,
    name,
    started_at: first.timestamp,
    ended_at: last.timestamp,
    status: events.some((event) => event.type.endsWith('.failed')) ? 'error' : 'ok',
    event_ids: events.map((event) => event.id),
    attributes: { provider: first.provider, model: first.model, item_id: first.item_id },
  };
}
function spanName(type: string): string | undefined {
  if (type.startsWith('model.')) return 'model';
  if (type.startsWith('tool.')) return 'tool';
  if (type.startsWith('mcp.tools.cache.') || type.startsWith('prompt.cache_section.'))
    return 'cache';
  if (type.startsWith('mcp.')) return 'mcp';
  if (type.startsWith('workspace.')) return 'workspace';
  if (type.startsWith('approval.')) return 'approval';
  if (type.startsWith('retry.')) return 'retry';
  if (type.startsWith('handoff.')) return 'handoff';
  if (type.startsWith('guardrail.')) return 'guardrail';
  if (type.startsWith('eval.')) return 'eval';
  return undefined;
}
function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}
function readNumber(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}
