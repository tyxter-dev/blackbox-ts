import { AgentRuntime, ProviderRegistry } from 'blackbox-ts';
import { DeterministicDuplexTransport, OpenAIRealtimeProvider } from 'blackbox-ts/realtime';

const registry = new ProviderRegistry();
registry.registerRealtimeProvider(
  new OpenAIRealtimeProvider(() => new DeterministicDuplexTransport()),
);
const session = await new AgentRuntime({ registry }).realtime.connect({
  model: 'openai-realtime:gpt-realtime',
});
await session.sendText('hello');
await session.close();
