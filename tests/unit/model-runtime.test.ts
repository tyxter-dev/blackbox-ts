import { describe, expect, it } from 'vitest';

import {
  EchoModelProvider,
  AgentEventTypes,
  FakeClock,
  FakeModelProvider,
  ModelRuntime,
  ProviderRegistry,
} from '../../src/index.js';

describe('model runtime', () => {
  it('provides an offline deterministic Echo model provider', async () => {
    const registry = new ProviderRegistry();
    registry.registerModelProvider(new EchoModelProvider());
    const result = await new ModelRuntime(registry).run({
      model: 'echo:echo',
      input: 'echo this',
      trace_id: 'trace_echo',
    });
    expect(result.output_text).toBe('echo this');
    expect(result.raw_response).toEqual({ echo: 'echo this' });
  });
  it('collects run from the canonical event stream and stamps correlation fields', async () => {
    const provider = new FakeModelProvider({ id: 'echo', model: 'echo-1', outputText: 'hello' });
    const registry = new ProviderRegistry();
    registry.registerModelProvider(provider);
    const runtime = new ModelRuntime(registry);

    const result = await runtime.run({
      model: 'echo:echo-1',
      input: 'say hello',
      trace_id: 'trace_1',
    });

    expect(result.output_text).toBe('hello');
    expect(result.events?.map((event) => event.type)).toEqual([
      AgentEventTypes.MODEL_REQUEST_STARTED,
      AgentEventTypes.MODEL_COMPLETED,
    ]);
    expect(result.events?.map((event) => event.sequence)).toEqual([0, 1]);
    expect(new Set(result.events?.map((event) => event.run_id)).size).toBe(1);
    expect(result.events?.every((event) => event.trace_id === 'trace_1')).toBe(true);
  });

  it('normalizes nested controls before provider dispatch and rejects conflicts', async () => {
    const provider = new FakeModelProvider({ id: 'echo' });
    const registry = new ProviderRegistry();
    registry.registerModelProvider(provider);
    const runtime = new ModelRuntime(registry);

    await runtime.run({
      provider: 'echo',
      model: 'echo-model',
      input: 'hello',
      trace_id: 'trace_2',
      controls: { max_output_tokens: 123, top_p: 0.5 },
    });
    expect(provider.turns[0]).toMatchObject({ max_output_tokens: 123, top_p: 0.5 });

    await expect(
      runtime.run({
        provider: 'echo',
        model: 'echo-model',
        input: 'hello',
        trace_id: 'trace_3',
        max_output_tokens: 10,
        controls: { max_output_tokens: 20 },
      }),
    ).rejects.toMatchObject({ code: 'conflicting_request_control' });
  });

  it('provides a deterministic fake clock for retry and lease contract suites', async () => {
    const clock = new FakeClock('2026-01-01T00:00:00.000Z');
    let woke = false;
    const sleeping = clock.sleep(1_000).then(() => {
      woke = true;
    });

    clock.advance(999);
    await Promise.resolve();
    expect(woke).toBe(false);
    clock.advance(1);
    await sleeping;
    expect(clock.now().toISOString()).toBe('2026-01-01T00:00:01.000Z');
  });
});
