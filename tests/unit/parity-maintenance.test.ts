import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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

    expect(parentFeatures).toHaveLength(144);
    expect(new Set(parentFeatures.map((feature) => feature.id)).size).toBe(144);
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
    expect(baseline.evidence_files).toHaveLength(129);
    expect(baseline.test_files).toHaveLength(118);
    expect(crosswalk.parent_commit).toBe(inventory.parent.commit);
    expect(crosswalk.entries.map((entry) => entry.python_test).sort()).toEqual(
      baseline.test_files.map((entry) => entry.path).sort(),
    );
    expect(crosswalk.feature_coverage).toHaveLength(144);
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
    expect(pythonCatalogs.models).toHaveLength(29);
    expect(pythonCatalogs.pricing).toHaveLength(36);
    expect(typescriptCore).toMatchObject({
      generated_by: 'blackbox-ts',
      target_parent_commit: inventory.parent.commit,
    });
  });
});

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), 'utf8')) as T;
}

describe('offline parity pin guard', () => {
  let scratch: string;
  const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
  const carriers = [
    ['docs/parent-baseline.json', 'parent_commit'],
    ['docs/parity-test-crosswalk.json', 'parent_commit'],
    ['docs/catalog-snapshot.json', 'parent_commit'],
    ['tests/fixtures/python/core-contracts.json', 'parent_commit'],
    ['tests/fixtures/python/catalogs.json', 'parent_commit'],
    ['tests/fixtures/python/provider-differential.json', 'parent_commit'],
    ['tests/fixtures/typescript/core-contracts.json', 'target_parent_commit'],
  ] as const;

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), 'blackbox-parity-pin-'));
    for (const directory of ['src', 'tests', 'docs']) {
      cpSync(join(repoRoot, directory), join(scratch, directory), { recursive: true });
    }
    mkdirSync(join(scratch, 'scripts'));
    cpSync(
      join(repoRoot, 'scripts/check-parity-inventory.mjs'),
      join(scratch, 'scripts/check-parity-inventory.mjs'),
    );
  });
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  function check() {
    return spawnSync(process.execPath, [join(scratch, 'scripts/check-parity-inventory.mjs')], {
      encoding: 'utf8',
      windowsHide: true,
    });
  }

  function withCarrier(path: string, contents: string | undefined, assertion: () => void) {
    const target = join(scratch, path);
    const original = readFileSync(target, 'utf8');
    try {
      if (contents === undefined) rmSync(target);
      else writeFileSync(target, contents);
      assertion();
    } finally {
      writeFileSync(target, original);
    }
  }

  it('accepts synchronized artifacts without any workflow or Python checkout', () => {
    const result = check();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('6 fixture/artifact headers');
  });

  it.each(carriers)('rejects a stale pin in %s', (path, field) => {
    const value = JSON.parse(readFileSync(join(scratch, path), 'utf8')) as Record<string, unknown>;
    value[field] = '0'.repeat(40);
    withCarrier(path, JSON.stringify(value), () => {
      const result = check();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        path === 'docs/parent-baseline.json'
          ? 'Parent baseline and parity inventory commits do not match.'
          : `${path} records ${field}`,
      );
    });
  });

  it('rejects inherited object keys as statuses', () => {
    const path = 'docs/parity-inventory.json';
    const value = JSON.parse(readFileSync(join(scratch, path), 'utf8')) as {
      groups: { target_status: string }[];
    };
    value.groups[0]!.target_status = 'constructor';
    withCarrier(path, JSON.stringify(value), () => {
      const result = check();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Unknown target_status 'constructor'");
    });
  });

  it('rejects a baseline from a different repository', () => {
    const path = 'docs/parent-baseline.json';
    const value = JSON.parse(readFileSync(join(scratch, path), 'utf8')) as Record<string, unknown>;
    value.parent_repository = 'different/repository';
    withCarrier(path, JSON.stringify(value), () => {
      const result = check();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        'Parent baseline and parity inventory repositories do not match.',
      );
    });
  });

  it.each(carriers)('fails closed for missing or malformed %s', (path) => {
    for (const contents of [undefined, '{invalid']) {
      withCarrier(path, contents, () => {
        const result = check();
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
          contents === undefined
            ? `Required parity pin carrier '${path}' is missing or unreadable.`
            : `Parity pin carrier '${path}' is not valid JSON.`,
        );
      });
    }
  });
});
