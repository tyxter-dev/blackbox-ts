import { EchoModelProvider, ModelRuntime, ProviderRegistry } from 'blackbox-ts';

const registry = new ProviderRegistry();
registry.registerModelProvider(new EchoModelProvider());
const result = await new ModelRuntime(registry).run({
  model: 'echo:echo',
  input: 'hello',
  trace_id: crypto.randomUUID(),
});
console.log(result.output_text);
