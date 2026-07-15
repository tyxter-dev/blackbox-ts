import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';

import {
  AgentEventTypes,
  EnvironmentWorker,
  InMemoryWorkSource,
  MemoryEventSink,
  OpenTelemetryEventSink,
  WorkerCredentials,
  createAgentEvent,
  diffRuns,
  evaluateRun,
  extractStandardMetrics,
  reconstructTrace,
} from '../../src/index.js';

describe('environment workers', () => {
  it('reclaims stale leases deterministically and rejects lease races', () => {
    let now = new Date('2026-01-01T00:00:00Z');
    const source = new InMemoryWorkSource([{ id: 'one', payload: { task: 1 } }], () => now);
    const first = source.claim({ lease_ms: 1000, worker_id: 'first' });
    if (first?.lease_id === undefined) throw new Error('Expected first lease.');
    now = new Date('2026-01-01T00:00:02Z');
    const second = source.claim({ lease_ms: 1000, worker_id: 'second' });
    if (second?.lease_id === undefined) throw new Error('Expected reclaimed lease.');

    expect(second.attempts).toBe(2);
    expect(() => source.complete('one', first.lease_id!, { output: 'stale' })).toThrowError(
      expect.objectContaining({ code: 'work_lease_mismatch' }),
    );
    source.complete('one', second.lease_id, { output: 'done' });
    expect(source.stats()).toMatchObject({ completed: 1, reclaimed: 1 });
  });

  it('drains work, accounts for lost leases, and keeps credentials secret-safe', async () => {
    let now = new Date('2026-01-01T00:00:00Z');
    const source = new InMemoryWorkSource(
      [
        { id: 'ok', payload: 'ok' },
        { id: 'lost', payload: 'lost' },
      ],
      () => now,
    );
    const credentials = new WorkerCredentials('top-secret', { scopes: ['work:execute'] });
    const worker = new EnvironmentWorker(
      source,
      (item) => {
        if (item.id === 'lost') {
          now = new Date(now.getTime() + 60_000);
          source.stop();
        }
        return item.payload;
      },
      { lease_ms: 1000, credentials },
    );
    const status = await worker.drain();

    expect(status).toMatchObject({ claimed: 2, completed: 1, lost_leases: 1 });
    expect(JSON.stringify(credentials)).not.toContain('top-secret');
    expect(inspect(credentials)).not.toContain('top-secret');
  });
});

describe('advanced observability', () => {
  function fixture(output: string) {
    return [
      createAgentEvent({
        id: 'started',
        type: AgentEventTypes.RUN_STARTED,
        run_id: 'run_1',
        trace_id: 'trace_1',
        timestamp: '2026-01-01T00:00:00.000Z',
      }),
      createAgentEvent({
        id: 'model_started',
        type: AgentEventTypes.MODEL_REQUEST_STARTED,
        run_id: 'run_1',
        trace_id: 'trace_1',
        timestamp: '2026-01-01T00:00:00.100Z',
      }),
      createAgentEvent({
        id: 'token',
        type: AgentEventTypes.MODEL_TEXT_DELTA,
        run_id: 'run_1',
        trace_id: 'trace_1',
        timestamp: '2026-01-01T00:00:00.250Z',
        data: { delta: output },
      }),
      createAgentEvent({
        id: 'completed',
        type: AgentEventTypes.RUN_COMPLETED,
        run_id: 'run_1',
        trace_id: 'trace_1',
        timestamp: '2026-01-01T00:00:01.000Z',
        data: {
          output,
          metadata: {
            validation_attempts: 1,
            usage: { input_tokens: 10, output_tokens: 2 },
          },
        },
      }),
    ];
  }

  it('reconstructs topology, extracts metrics, exports, evaluates, and diffs', async () => {
    const events = fixture('one');
    const trace = reconstructTrace(events);
    const metrics = extractStandardMetrics(events);
    expect(trace.spans.map((span) => span.name)).toEqual(['agent.run', 'model']);
    expect(metrics).toMatchObject({ latency_ms: 1000, first_token_ms: 250, input_tokens: 10 });

    const exported: unknown[] = [];
    const exporter = new OpenTelemetryEventSink({ export: (spans) => exported.push(spans) });
    for (const event of events) await exporter.emit(event);
    expect(exported).toHaveLength(1);

    const sink = new MemoryEventSink();
    const evaluations = await evaluateRun(
      events,
      [{ name: 'contains', evaluate: (run) => run.length > 0 }],
      sink,
    );
    expect(evaluations).toEqual({ contains: true });
    expect(sink.events.map((event) => event.type)).toEqual([
      AgentEventTypes.EVAL_STARTED,
      AgentEventTypes.EVAL_COMPLETED,
    ]);
    expect(diffRuns(events, fixture('two')).output_changed).toBe(true);
  });
});
