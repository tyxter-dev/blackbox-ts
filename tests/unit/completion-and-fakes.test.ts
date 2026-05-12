import { describe, expect, it } from 'vitest';
import { complete, FakeModelProvider, ScriptedModelProvider } from '../../src/index.js';

describe('completion compatibility', () => {
  it('maps current completion inputs onto provider turns', async () => {
    const provider = new FakeModelProvider({ id: 'fake', model: 'fake-model', outputText: 'done' });

    const result = await complete(provider, {
      system: 'You are concise.',
      messages: [{ role: 'user', content: 'Say done' }],
      trace_id: 'trace_1',
    });

    expect(result).toMatchObject({
      content: 'done',
      model: 'fake-model',
      provider: 'fake',
    });
    expect(provider.turns[0]).toMatchObject({
      model: 'fake-model',
      instructions: 'You are concise.',
      trace_id: 'trace_1',
    });
  });

  it('supports scripted provider fixture behavior', async () => {
    const provider = new ScriptedModelProvider([{ output_text: 'first' }, { output_text: 'second' }]);

    await expect(
      complete(provider, {
        system: '',
        messages: [{ role: 'user', content: '1' }],
        trace_id: 'trace_1',
      }),
    ).resolves.toMatchObject({ content: 'first' });

    await expect(
      complete(provider, {
        system: '',
        messages: [{ role: 'user', content: '2' }],
        trace_id: 'trace_2',
      }),
    ).resolves.toMatchObject({ content: 'second' });
  });
});
