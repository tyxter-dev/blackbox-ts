import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import {
  AgentRuntime,
  CallbackEventSink,
  FanoutEventSink,
  FakeModelProvider,
  InMemoryEventStore,
  InMemoryProviderCacheStore,
  InMemoryRunStore,
  InMemorySessionStore,
  JSONLEventStore,
  MemoryEventSink,
  ProviderRegistry,
  RedactingEventSink,
  ScriptedModelProvider,
  SessionCursorError,
  createAgentEvent,
  createAgentSession,
  createRunState,
  createProviderCacheEntry,
  createProviderState,
  createSessionSnapshot,
  deriveCapabilityProfile,
  rawEnvelope,
} from '../../src/index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('persistence stores', () => {
  it('supports ordered event cursors and immutable run/session snapshots', () => {
    const events = new InMemoryEventStore();
    const first = createAgentEvent({ type: 'run.started', run_id: 'run_1' });
    const second = createAgentEvent({ type: 'run.completed', run_id: 'run_1' });
    events.append(first);
    events.append(second);

    expect(events.list({ run_id: 'run_1', after_event_id: first.id })).toEqual([second]);
    expect(() => events.list({ after_event_id: 'missing' })).toThrow(SessionCursorError);

    const runs = new InMemoryRunStore();
    const run = createRunState({ session_id: 'sess_1', metadata: { version: 1 } });
    runs.save(run);
    expect(runs.load('sess_1')).toEqual(run);
    expect(runs.load('sess_1')).not.toBe(run);

    const sessions = new InMemorySessionStore();
    const session = createAgentSession({ id: 'sess_1', provider: 'local', task: 'test' });
    sessions.save(createSessionSnapshot(session));
    sessions.appendEvent('sess_1', first);
    expect(sessions.load('sess_1')?.events).toEqual([first]);
  });

  it('expires and invalidates provider cache entries with an injected clock', () => {
    let now = new Date('2026-01-01T00:00:00.000Z');
    const cache = new InMemoryProviderCacheStore(() => now);
    cache.set(
      createProviderCacheEntry('models', 'openai', { count: 2 }, { ttl_ms: 1000, created_at: now }),
    );
    expect(cache.get('models')?.value).toEqual({ count: 2 });
    now = new Date('2026-01-01T00:00:02.000Z');
    expect(cache.get('models')).toBeUndefined();
  });

  it('persists versioned JSONL, redacts non-storable raw data, and reports corruption', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'blackbox-ts-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'events.jsonl');
    const store = new JSONLEventStore(path);
    await store.append(
      createAgentEvent({
        type: 'model.completed',
        run_id: 'run_1',
        raw: rawEnvelope('openai', { api_key: 'secret' }, { storage_allowed: false }),
      }),
    );

    const [event] = await store.list({ run_id: 'run_1' });
    expect(event?.raw).toMatchObject({
      payload: '<redacted:not-storage-allowed>',
      redaction_status: 'redacted',
    });

    await writeFile(path, 'not-json\n', 'utf8');
    await expect(store.list()).rejects.toMatchObject({ code: 'corrupt_jsonl_record' });
  });
});

describe('event sinks and runtime wiring', () => {
  it('isolates fanout failures and redacts sensitive envelopes', async () => {
    const memory = new MemoryEventSink();
    const failing = new CallbackEventSink(() => {
      throw new Error('telemetry down');
    });
    const fanout = new FanoutEventSink([new RedactingEventSink(memory), failing]);
    await fanout.emit(
      createAgentEvent({
        type: 'run.completed',
        raw: rawEnvelope('openai', { token: 'secret' }, { sensitivity: 'secret' }),
      }),
    );

    expect(fanout.failures).toHaveLength(1);
    expect(memory.events[0]?.raw).toMatchObject({
      payload: '<redacted>',
      redaction_status: 'redacted',
    });
  });

  it('makes AgentRuntime.run a collector over the persisted and observed stream', async () => {
    const registry = new ProviderRegistry();
    registry.registerModelProvider(new FakeModelProvider({ id: 'echo', outputText: 'done' }));
    const store = new InMemoryEventStore();
    const sink = new MemoryEventSink();
    const runtime = new AgentRuntime({ registry, event_store: store, event_sink: sink });

    const result = await runtime.run({
      model: 'echo:model',
      input: 'go',
      trace_id: 'trace_store',
    });

    expect(store.list({ run_id: result.events[0]?.run_id })).toEqual(result.events);
    expect(sink.events).toEqual(result.events);
  });

  it('resumes a fresh runtime from persisted native provider state', async () => {
    const runs = new InMemoryRunStore();
    const state = createProviderState({
      provider: 'script',
      model: 'model',
      previous_response_id: 'response_1',
    });
    const firstRegistry = new ProviderRegistry();
    firstRegistry.registerModelProvider(
      new ScriptedModelProvider([{ output_text: 'first', provider_state: state }], {
        id: 'script',
        capabilities: (model) =>
          deriveCapabilityProfile(
            'script',
            {
              streaming_events: true,
              provider_state: true,
            },
            model,
          ),
      }),
    );
    const firstRuntime = new AgentRuntime({ registry: firstRegistry, run_store: runs });
    await firstRuntime.run({
      model: 'script:model',
      input: 'start',
      session_id: 'session_resume',
    });

    const resumedProvider = new ScriptedModelProvider([{ output_text: 'continued' }], {
      id: 'script',
      capabilities: (model) =>
        deriveCapabilityProfile(
          'script',
          {
            streaming_events: true,
            provider_state: true,
          },
          model,
        ),
    });
    const secondRegistry = new ProviderRegistry();
    secondRegistry.registerModelProvider(resumedProvider);
    const secondRuntime = new AgentRuntime({ registry: secondRegistry, run_store: runs });
    const result = await secondRuntime.resume('session_resume', {
      model: 'script:model',
      input: 'continue',
    });

    expect(result.text).toBe('continued');
    expect(resumedProvider.turns[0]?.provider_state).toEqual(state);
  });
});
