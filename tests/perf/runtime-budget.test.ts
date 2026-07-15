import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';

import {
  AgentRuntime,
  EchoModelProvider,
  ProviderRegistry,
  bundledProviderModelCatalog,
} from '../../src/index.js';

describe('performance budgets', () => {
  it('keeps catalog lookup and offline model collection within a broad regression budget', async () => {
    const catalog = bundledProviderModelCatalog();
    const registry = new ProviderRegistry();
    registry.registerModelProvider(new EchoModelProvider());
    const runtime = new AgentRuntime({ registry });
    const started = performance.now();

    for (let index = 0; index < 10_000; index += 1) {
      catalog.get('openai', index % 2 === 0 ? 'gpt-5.4-mini' : 'gpt-5.4-mini-2026-03-17');
    }
    for (let index = 0; index < 100; index += 1) {
      await runtime.models.run({ model: 'echo:echo-mini', input: `turn ${index}` });
    }

    expect(performance.now() - started).toBeLessThan(5_000);
  });
});
