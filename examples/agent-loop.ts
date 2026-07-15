import { AgentRuntime, EchoModelProvider, ProviderRegistry } from 'blackbox-ts';

const registry = new ProviderRegistry();
registry.registerModelProvider(new EchoModelProvider());
const runtime = new AgentRuntime({ registry });
console.log(await runtime.run({ model: 'echo:echo', input: 'run', trace_id: crypto.randomUUID() }));
