import { inspect } from 'node:util';
import { describe, expect, it, vi } from 'vitest';

import {
  AgentEventTypes,
  EnvironmentWorker,
  InMemoryWorkSource,
  MemoryEventSink,
  OpenTelemetryEventSink,
  WorkerCredentials,
  createAgentEvent,
  denyPolicy,
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
    const results = await worker.drain();
    const status = worker.status();

    expect(status).toMatchObject({ claimed: 2, completed: 1, lost_leases: 1 });
    expect(results.map((result) => result.status)).toEqual(['completed', 'stopped']);
    expect(results[1]?.metadata).toMatchObject({ lease_lost: true });
    expect(JSON.stringify(credentials)).not.toContain('top-secret');
    expect(inspect(credentials)).not.toContain('top-secret');
  });

  it('claims before policy evaluation and posts denied work as skipped', async () => {
    const source = new InMemoryWorkSource([{ id: 'denied', payload: 'secret' }]);
    const handler = vi.fn();
    const policy = {
      check: vi.fn((request: { readonly action: string; readonly arguments: object }) => {
        expect(request.action).toBe('denied');
        expect(request.arguments).toMatchObject({ work_id: 'denied' });
        return denyPolicy('tenant not allowed');
      }),
    };
    const worker = new EnvironmentWorker(source, handler, { policy });

    expect(await worker.handleOne()).toMatchObject({ status: 'skipped' });

    expect(handler).not.toHaveBeenCalled();
    expect(source.get('denied')).toMatchObject({ attempts: 1, status: 'skipped' });
    expect(worker.status()).toMatchObject({ claimed: 1, skipped: 1, handled: 1 });
  });

  it('automatically keeps a short lease alive while a handler runs', async () => {
    const source = new InMemoryWorkSource([{ id: 'slow', payload: 'slow' }]);
    const worker = new EnvironmentWorker(
      source,
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 45));
        return 'done';
      },
      { lease_ms: 20, heartbeat_ms: 5 },
    );

    expect(await worker.handleOne()).toMatchObject({ status: 'completed', output: 'done' });
    expect(source.get('slow')).toMatchObject({ status: 'completed' });
    expect(worker.status()).toMatchObject({ completed: 1, lost_leases: 0 });
  });

  it('accepts parent-style terminal WorkResult values from handlers', async () => {
    const source = new InMemoryWorkSource([{ id: 'failed', payload: 'work' }]);
    const worker = new EnvironmentWorker(source, () => ({
      status: 'failed' as const,
      error: 'business failure',
    }));

    await expect(worker.handleOne()).resolves.toEqual({
      status: 'failed',
      error: 'business failure',
    });
    expect(source.get('failed')).toMatchObject({ status: 'failed' });
    expect(worker.status()).toMatchObject({ failed: 1, handled: 1 });
  });

  it('polls continuously in run mode and exits after a graceful stop', async () => {
    const source = new InMemoryWorkSource<string>();
    const worker = new EnvironmentWorker(
      source,
      async (item) => {
        await worker.stop();
        return item.payload;
      },
      { poll_interval_ms: 5 },
    );
    const running = worker.run();
    await new Promise((resolve) => setTimeout(resolve, 15));
    source.enqueue('late', 'arrived');

    const status = await running;

    expect(source.get('late')).toMatchObject({ status: 'completed' });
    expect(status).toMatchObject({ completed: 1, state: 'stopped', stopped: true });
  });

  it('cancels and posts stopped when the control plane requests a stop', async () => {
    const source = new InMemoryWorkSource([{ id: 'controlled', payload: 'wait' }]);
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => (started = resolve));
    const worker = new EnvironmentWorker(
      source,
      async (_item, context) => {
        started();
        await new Promise<void>((_resolve, reject) =>
          context.signal.addEventListener(
            'abort',
            () =>
              reject(
                context.signal.reason instanceof Error
                  ? context.signal.reason
                  : new Error('Work item cancelled.'),
              ),
            { once: true },
          ),
        );
      },
      { lease_ms: 100, heartbeat_ms: 5 },
    );

    const handling = worker.handleOne();
    await didStart;
    source.requestStop('controlled');
    await handling;

    expect(source.get('controlled')).toMatchObject({ status: 'stopped' });
    expect(worker.status()).toMatchObject({ stopped_items: 1, lost_leases: 0 });
  });

  it('cancels in-flight work on a forced worker stop', async () => {
    const source = new InMemoryWorkSource([{ id: 'forced', payload: 'wait' }]);
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => (started = resolve));
    const worker = new EnvironmentWorker(source, async (_item, context) => {
      started();
      await new Promise<void>((_resolve, reject) =>
        context.signal.addEventListener(
          'abort',
          () =>
            reject(
              context.signal.reason instanceof Error
                ? context.signal.reason
                : new Error('Work item cancelled.'),
            ),
          { once: true },
        ),
      );
    });

    const handling = worker.handleOne();
    await didStart;
    await worker.stop({ force: true });
    await handling;

    expect(source.get('forced')).toMatchObject({ status: 'stopped' });
    expect(worker.status()).toMatchObject({ stopped_items: 1, state: 'stopped' });
  });

  it('cancels forced work and records lease loss without overwriting reclaimed work', async () => {
    let now = new Date('2026-01-01T00:00:00Z');
    const source = new InMemoryWorkSource([{ id: 'lost', payload: 'wait' }], () => now);
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => (started = resolve));
    const worker = new EnvironmentWorker(
      source,
      async (_item, context) => {
        started();
        await new Promise<void>((_resolve, reject) =>
          context.signal.addEventListener(
            'abort',
            () =>
              reject(
                context.signal.reason instanceof Error
                  ? context.signal.reason
                  : new Error('Work item cancelled.'),
              ),
            { once: true },
          ),
        );
      },
      { lease_ms: 20, heartbeat_ms: 5 },
    );

    const handling = worker.handleOne();
    await didStart;
    now = new Date('2026-01-01T00:00:01Z');
    await handling;

    expect(worker.status()).toMatchObject({ lost_leases: 1, stopped_items: 0 });
    expect(source.stats()).toMatchObject({ pending: 1, reclaimed: 1 });
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
        id: 'cache',
        type: AgentEventTypes.PROMPT_CACHE_SECTION_CREATED,
        run_id: 'run_1',
        trace_id: 'trace_1',
        timestamp: '2026-01-01T00:00:00.300Z',
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
    expect(trace.spans.map((span) => span.name)).toEqual(['agent.run', 'model', 'cache']);
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
