import { AgentRuntime, EchoModelProvider, LocalAgentProvider, ProviderRegistry } from 'blackbox-ts';

const registry = new ProviderRegistry();
registry.registerModelProvider(new EchoModelProvider());
const runtime = new AgentRuntime({ registry });
registry.registerAgentProvider(new LocalAgentProvider(runtime));
const agent = await runtime.agents.createAgent('local', { name: 'echo', model: 'echo:echo' });
const session = await runtime.agents.start('local', agent, { input: 'session task' });
console.log(await runtime.agents.run(session));
