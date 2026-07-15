import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface Inventory {
  readonly parent: { readonly commit: string; readonly feature_catalog: string };
  readonly groups: readonly {
    readonly classification: 'parent' | 'supplement';
    readonly features: readonly { readonly id: string }[];
  }[];
  readonly extensions: readonly {
    readonly id: string;
    readonly classification: string;
    readonly included_in_python_parity_score: boolean;
  }[];
}

interface Baseline {
  readonly parent_commit: string;
  readonly feature_catalog: { readonly path: string };
  readonly evidence_files: readonly unknown[];
  readonly test_files: readonly { readonly path: string }[];
}

interface Crosswalk {
  readonly parent_commit: string;
  readonly entries: readonly { readonly python_test: string }[];
  readonly feature_coverage: readonly unknown[];
}

interface PythonFixture {
  readonly generated_by: string;
  readonly parent_commit: string;
}

interface ProviderFixture extends PythonFixture {
  readonly scenarios: readonly { readonly provider: string }[];
}

interface CatalogFixture extends PythonFixture {
  readonly models: readonly unknown[];
  readonly pricing: readonly unknown[];
}

interface TypeScriptFixture {
  readonly generated_by: string;
  readonly target_parent_commit: string;
}

const inventory = readJson<Inventory>('../../docs/parity-inventory.json');
const baseline = readJson<Baseline>('../../docs/parent-baseline.json');
const crosswalk = readJson<Crosswalk>('../../docs/parity-test-crosswalk.json');
const pythonCore = readJson<PythonFixture>('../fixtures/python/core-contracts.json');
const pythonCatalogs = readJson<CatalogFixture>('../fixtures/python/catalogs.json');
const pythonProviders = readJson<ProviderFixture>('../fixtures/python/provider-differential.json');
const typescriptCore = readJson<TypeScriptFixture>('../fixtures/typescript/core-contracts.json');

describe('Python parity maintenance artifacts', () => {
  it('separates parent features, verification supplements, and TypeScript extensions', () => {
    const parentGroups = inventory.groups.filter((group) => group.classification === 'parent');
    const supplements = inventory.groups.filter((group) => group.classification === 'supplement');
    const parentFeatures = parentGroups.flatMap((group) => group.features);
    const supplementFeatures = supplements.flatMap((group) => group.features);

    expect(parentFeatures).toHaveLength(143);
    expect(new Set(parentFeatures.map((feature) => feature.id)).size).toBe(143);
    expect(supplementFeatures).toHaveLength(26);
    expect(inventory.extensions).toHaveLength(1);
    expect(inventory.extensions[0]).toMatchObject({
      id: 'extension.openrouter',
      classification: 'extension',
      included_in_python_parity_score: false,
    });
  });

  it('pins the evidence baseline and crosswalk to the same parent commit', () => {
    expect(baseline.parent_commit).toBe(inventory.parent.commit);
    expect(baseline.feature_catalog.path).toBe(inventory.parent.feature_catalog);
    expect(baseline.evidence_files).toHaveLength(109);
    expect(baseline.test_files).toHaveLength(108);
    expect(crosswalk.parent_commit).toBe(inventory.parent.commit);
    expect(crosswalk.entries.map((entry) => entry.python_test).sort()).toEqual(
      baseline.test_files.map((entry) => entry.path).sort(),
    );
    expect(crosswalk.feature_coverage).toHaveLength(143);
  });

  it('keeps both fixture directions and provider/catalog differentials synchronized', () => {
    for (const fixture of [pythonCore, pythonCatalogs, pythonProviders]) {
      expect(fixture.generated_by).toBe('python-parent');
      expect(fixture.parent_commit).toBe(inventory.parent.commit);
    }
    expect(pythonProviders.scenarios.map((scenario) => scenario.provider).sort()).toEqual([
      'anthropic',
      'google',
      'openai',
      'xai',
    ]);
    expect(pythonCatalogs.models).toHaveLength(19);
    expect(pythonCatalogs.pricing).toHaveLength(21);
    expect(typescriptCore).toMatchObject({
      generated_by: 'blackbox-ts',
      target_parent_commit: inventory.parent.commit,
    });
  });
});

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), 'utf8')) as T;
}
