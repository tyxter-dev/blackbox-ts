import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { bundledProviderModels } from '../../src/providers/catalog.js';
import { BUNDLED_PRICING } from '../../src/pricing/index.js';

const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/python/catalogs.json', import.meta.url), 'utf8'),
) as {
  readonly parent_commit: string;
  readonly models: readonly unknown[];
  readonly pricing: readonly unknown[];
};
const inventory = JSON.parse(
  readFileSync(new URL('../../docs/parity-inventory.json', import.meta.url), 'utf8'),
) as { readonly parent: { readonly commit: string } };

describe('Python catalog differential fixtures', () => {
  it('keeps every bundled model identical to the pinned parent', () => {
    expect(fixture.parent_commit).toBe(inventory.parent.commit);
    expect(bundledProviderModels().map(normalizeModel)).toEqual(fixture.models);
    expect(fixture.models).toHaveLength(19);
  });

  it('keeps every bundled price and provenance field identical to the pinned parent', () => {
    expect(BUNDLED_PRICING.list().map(jsonValue)).toEqual(fixture.pricing);
    expect(fixture.pricing).toHaveLength(21);
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
