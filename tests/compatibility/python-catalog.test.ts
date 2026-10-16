import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { ProviderModelCatalog, bundledProviderModels } from '../../src/providers/catalog.js';
import { BUNDLED_PRICING, PricingCatalog } from '../../src/pricing/index.js';

const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/python/catalogs.json', import.meta.url), 'utf8'),
) as {
  readonly parent_commit: string;
  readonly models: readonly unknown[];
  readonly pricing: readonly unknown[];
};
const inventory = JSON.parse(
  readFileSync(new URL('../../docs/parity-inventory.json', import.meta.url), 'utf8'),
) as { readonly python_reference: { readonly commit: string } };

describe('Frozen Python catalog compatibility samples', () => {
  it('preserves the adopted bundled model snapshot', () => {
    expect(fixture.parent_commit).toBe(inventory.python_reference.commit);
    assertFrozenRows(bundledProviderModels().map(normalizeModel), fixture.models);
    expect(fixture.models).toHaveLength(29);
  });

  it('admits TypeScript-native model and pricing rows beyond frozen Python adoption', () => {
    const models = new ProviderModelCatalog([
      ...bundledProviderModels(),
      { ...bundledProviderModels()[0]!, provider: 'native', id: 'native-model', aliases: [] },
    ]);
    const prices = new PricingCatalog([
      ...BUNDLED_PRICING.list(),
      { ...BUNDLED_PRICING.list()[0]!, provider: 'native', model: 'native-model' },
    ]);
    expect(models.get('native', 'native-model').id).toBe('native-model');
    expect(prices.get('native', 'native-model')?.model).toBe('native-model');
    assertFrozenRows(models.list().map(normalizeModel), fixture.models);
    assertFrozenRows(prices.list().map(jsonValue), fixture.pricing);
  });

  it('rejects missing or changed adopted rows despite admitting native extensions', () => {
    const models = bundledProviderModels().map(normalizeModel);
    const prices = BUNDLED_PRICING.list().map(jsonValue);
    expect(() => assertFrozenRows(models.slice(1), fixture.models)).toThrow();
    expect(() => assertFrozenRows(prices.slice(1), fixture.pricing)).toThrow();
    expect(() =>
      assertFrozenRows([...models.slice(1), { id: 'changed' }], fixture.models),
    ).toThrow();
    expect(() =>
      assertFrozenRows(
        [
          { ...prices[0]!, rates: { input_per_million: -1, output_per_million: -1 } },
          ...prices.slice(1),
        ],
        fixture.pricing,
      ),
    ).toThrow();
  });

  it('preserves normalized frozen pricing compatibility', () => {
    assertFrozenRows(BUNDLED_PRICING.list().map(jsonValue), fixture.pricing);
    expect(fixture.pricing).toHaveLength(36);
  });
});

function normalizeModel(model: ReturnType<typeof bundledProviderModels>[number]): unknown {
  return jsonValue({
    ...model,
    aliases: model.aliases ?? [],
    modalities: model.modalities ?? ['text'],
    metadata: model.metadata ?? {},
  });
}

function jsonValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function assertFrozenRows(actual: readonly unknown[], expected: readonly unknown[]): void {
  expect(actual).toEqual(expect.arrayContaining([...expected]));
}
