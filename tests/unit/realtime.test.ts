import { describe, expect, it } from 'vitest';

import {
  AgentEventTypes,
  AgentRuntime,
  DeterministicDuplexTransport,
  FakeRealtimeProvider,
  OpenAIRealtimeProvider,
  ProviderRegistry,
  RuntimeConfig,
} from '../../src/index.js';

describe('realtime runtime', () => {
  it('serializes duplex commands, maps raw events, updates config, and closes', async () => {
    const transport = new DeterministicDuplexTransport([
      { type: AgentEventTypes.REALTIME_OUTPUT_TEXT_DELTA, delta: 'hello' },
      { type: AgentEventTypes.REALTIME_INTERRUPTION_DETECTED, reason: 'speech' },
    ]);
    const registry = new ProviderRegistry();
    registry.registerRealtimeProvider(new OpenAIRealtimeProvider(() => transport));
    const runtime = new AgentRuntime({ registry });
    const session = await runtime.realtime.connect({
      model: 'openai-realtime:gpt-realtime',
      config: { input_modalities: ['text', 'audio'], output_modalities: ['text'] },
    });

    const text = session.sendText('hello');
    const audio = session.appendAudio(new Uint8Array([1, 2, 3]));
    const interrupt = session.interrupt();
    await Promise.all([text, audio, interrupt]);
    await session.update({ turn_detection: 'semantic_vad', interruption: true });
    const events = await session.collect();

    expect(transport.commands.map((command) => command.type)).toEqual([
      'input_text.submit',
      'input_audio.append',
      'response.cancel',
    ]);
    expect(events.map((event) => event.type)).toEqual([
      AgentEventTypes.REALTIME_SESSION_CONNECTED,
      AgentEventTypes.REALTIME_OUTPUT_TEXT_DELTA,
      AgentEventTypes.REALTIME_INTERRUPTION_DETECTED,
    ]);
    expect(events[1]?.raw).toMatchObject({ delta: 'hello' });
    expect(transport.updates).toEqual([{ turn_detection: 'semantic_vad', interruption: true }]);
    await session.close();
    expect(transport.closed).toBe(true);
    expect(() => session.sendText('closed')).toThrowError(
      expect.objectContaining({ code: 'realtime_session_closed' }),
    );
  });

  it('rejects unsupported modalities before transport creation', async () => {
    let connected = false;
    const registry = new ProviderRegistry();
    registry.registerRealtimeProvider(
      new OpenAIRealtimeProvider(() => {
        connected = true;
        return new DeterministicDuplexTransport();
      }),
    );
    const runtime = new AgentRuntime({ registry });

    await expect(
      runtime.realtime.connect({
        model: 'openai-realtime:gpt-realtime',
        config: { input_modalities: ['video'] },
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(connected).toBe(false);
  });

  it('expands the realtime_voice profile and reconnects with the prior session context', async () => {
    const provider = new FakeRealtimeProvider();
    const registry = new ProviderRegistry();
    registry.registerRealtimeProvider(provider);
    const runtime = new AgentRuntime({ registry });
    const session = await runtime.realtime.connect({
      runtime_config: RuntimeConfig.profile('realtime_voice').withOverrides({
        provider: 'fake-realtime:gpt-realtime',
      }),
    });

    expect(provider.connections[0]).toMatchObject({
      model: 'gpt-realtime',
      transport: 'websocket',
      tool_mode: 'manual',
      config: {
        input_modalities: ['text', 'audio'],
        output_modalities: ['text', 'audio'],
        voice: 'alloy',
      },
    });

    const reconnected = await runtime.realtime.reconnect(session);
    expect(reconnected.ref.id).not.toBe(session.ref.id);
    expect(provider.connections[1]?.metadata).toMatchObject({ reconnect_from: session.ref.id });
  });
});
