import { describe, expect, it, vi } from 'vitest';

import {
  AgentEventTypes,
  AgentRuntime,
  DeterministicDuplexTransport,
  FakeRealtimeProvider,
  OpenAIRealtimeProvider,
  ProviderRegistry,
  RuntimeConfig,
  ToolRegistry,
  createAgentEvent,
  deny,
  requireApproval,
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
    await expect(session.update({ input_modalities: ['video'] })).rejects.toBeInstanceOf(Error);
    expect(transport.updates).toHaveLength(1);
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

  it('keeps manual tool calls external and executes auto tool calls locally', async () => {
    const manualProvider = new FakeRealtimeProvider('manual-realtime');
    const manualRegistry = new ProviderRegistry();
    manualRegistry.registerRealtimeProvider(manualProvider);
    const tools = new ToolRegistry([
      { name: 'lookup', handler: ({ text }) => `local:${String(text)}` },
    ]);
    const manualRuntime = new AgentRuntime({ registry: manualRegistry, tools });
    const manual = await manualRuntime.realtime.connect({
      model: 'manual-realtime:model',
      tools: ['lookup'],
      tool_mode: 'manual',
    });
    manualProvider.queueEvent(
      manual.ref,
      createAgentEvent({
        type: AgentEventTypes.TOOL_CALL_REQUESTED,
        data: { call_id: 'manual_1', name: 'lookup', arguments: { text: 'hello' } },
      }),
    );
    const manualEvents = await manual.collect();
    expect(manualEvents.map((event) => event.type)).toContain(AgentEventTypes.TOOL_CALL_REQUESTED);
    expect(manualEvents.map((event) => event.type)).not.toContain(
      AgentEventTypes.TOOL_CALL_STARTED,
    );
    expect(manualProvider.commands).toHaveLength(0);

    const autoProvider = new FakeRealtimeProvider('auto-realtime');
    const autoRegistry = new ProviderRegistry();
    autoRegistry.registerRealtimeProvider(autoProvider);
    const autoRuntime = new AgentRuntime({ registry: autoRegistry, tools });
    const auto = await autoRuntime.realtime.connect({
      model: 'auto-realtime:model',
      tools: ['lookup'],
      tool_mode: 'auto',
    });
    autoProvider.queueEvent(
      auto.ref,
      createAgentEvent({
        type: AgentEventTypes.TOOL_CALL_REQUESTED,
        data: { call_id: 'auto_1', name: 'lookup', arguments: { text: 'hello' } },
      }),
    );
    const autoEvents = await auto.collect();
    expect(autoEvents.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        AgentEventTypes.TOOL_CALL_REQUESTED,
        AgentEventTypes.TOOL_CALL_STARTED,
        AgentEventTypes.TOOL_CALL_COMPLETED,
      ]),
    );
    expect(
      autoProvider.commands.some(
        (command) =>
          command.type === 'tool_result' &&
          command.data?.call_id === 'auto_1' &&
          command.data.output === 'local:hello',
      ),
    ).toBe(true);
  });

  it('pauses realtime auto tools for approval and returns denials to the provider', async () => {
    const provider = new FakeRealtimeProvider();
    const registry = new ProviderRegistry();
    registry.registerRealtimeProvider(provider);
    const runtime = new AgentRuntime({
      registry,
      tools: new ToolRegistry([{ name: 'lookup', handler: () => 'never' }]),
      policy: { check: () => requireApproval('review realtime tool') },
    });
    const session = await runtime.realtime.connect({
      model: 'fake-realtime:model',
      tools: ['lookup'],
      tool_mode: 'auto',
    });
    provider.queueEvent(
      session.ref,
      createAgentEvent({
        type: AgentEventTypes.TOOL_CALL_REQUESTED,
        data: { call_id: 'approval_1', name: 'lookup', arguments: {} },
      }),
    );
    const collecting = session.collect();
    await vi.waitFor(() => expect(runtime.realtime.approvals.pending()).toHaveLength(1));
    const pending = runtime.realtime.approvals.pending()[0];
    if (pending === undefined) throw new Error('Realtime approval request is missing.');
    runtime.realtime.approve(pending.id, deny('not allowed'));
    const events = await collecting;

    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        AgentEventTypes.APPROVAL_REQUESTED,
        AgentEventTypes.APPROVAL_DENIED,
        AgentEventTypes.TOOL_CALL_FAILED,
      ]),
    );
    expect(provider.commands.at(-1)).toMatchObject({
      type: 'tool_result',
      data: { call_id: 'approval_1', is_error: true },
    });
  });

  it('applies send backpressure, encodes binary audio, and preserves transcript order', async () => {
    const started: string[] = [];
    const completed: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const commands: Array<{
      readonly type: string;
      readonly data?: Readonly<Record<string, unknown>>;
    }> = [];
    const transport = {
      async send(command: {
        readonly type: string;
        readonly data?: Readonly<Record<string, unknown>>;
      }) {
        commands.push(command);
        started.push(command.type);
        if (commands.length === 1) await gate;
        completed.push(command.type);
      },
      async *events() {
        yield { type: AgentEventTypes.REALTIME_INPUT_TRANSCRIPT_DELTA, delta: 'first' };
        yield { type: AgentEventTypes.REALTIME_INPUT_TRANSCRIPT_COMPLETED, transcript: 'first' };
      },
      close() {},
    };
    const registry = new ProviderRegistry();
    registry.registerRealtimeProvider(new OpenAIRealtimeProvider(() => transport));
    const session = await new AgentRuntime({ registry }).realtime.connect({
      model: 'openai-realtime:gpt-realtime',
    });

    const text = session.sendText('first');
    const audio = session.appendAudio(new Uint8Array([1, 2, 3]));
    await vi.waitFor(() => expect(started).toEqual(['input_text.submit']));
    expect(completed).toEqual([]);
    release();
    await Promise.all([text, audio]);
    expect(started).toEqual(['input_text.submit', 'input_audio.append']);
    expect(commands[1]?.data).toEqual({ audio_base64: 'AQID' });

    const events = await session.collect();
    expect(events.slice(1).map((event) => event.type)).toEqual([
      AgentEventTypes.REALTIME_INPUT_TRANSCRIPT_DELTA,
      AgentEventTypes.REALTIME_INPUT_TRANSCRIPT_COMPLETED,
    ]);
    expect(events[1]?.raw).toMatchObject({ delta: 'first' });
  });
});
