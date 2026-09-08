import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

interface EvidenceSide {
  sources: string[];
  tests: string[];
  symbols: string[];
}
interface Inventory {
  python_reference: { commit: string; feature_catalog: string };
  groups: {
    id: string;
    domain: string;
    classification: 'feature' | 'supplement';
    features: { id: string; name: string; status: string; evidence: string[] }[];
  }[];
  python_requirements: {
    id: string;
    name: string;
    status: string;
    disposition?: string;
    feature_id?: string;
    reason?: string;
    evidence: string[];
  }[];
  evidence: Record<string, { parent?: EvidenceSide; typescript?: EvidenceSide }>;
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
  it('scores TypeScript-native features and retains unsupported scoped features without supplements', () => {
    const features = inventory.groups
      .filter((group) => group.classification === 'feature')
      .flatMap((group) => group.features);
    const supplements = inventory.groups
      .filter((group) => group.classification === 'supplement')
      .flatMap((group) => group.features);
    expect(features).toHaveLength(145);
    expect(features.filter((feature) => feature.status === 'supported')).toHaveLength(138);
    expect(supplements).toHaveLength(26);
    expect(features.find((feature) => feature.id === 'extension.openrouter')?.status).toBe(
      'supported',
    );
    expect(features.filter((feature) => feature.status === 'unsupported')).toHaveLength(1);
    expect(inventory.python_requirements).toHaveLength(144);
    expect(
      inventory.python_requirements.filter(
        (requirement) => requirement.disposition === 'unsupported',
      ),
    ).toHaveLength(1);
  });

  it('pins the evidence baseline and crosswalk to the same parent commit', () => {
    expect(baseline.parent_commit).toBe(inventory.python_reference.commit);
    expect(baseline.feature_catalog.path).toBe(inventory.python_reference.feature_catalog);
    expect(baseline.evidence_files).toHaveLength(129);
    expect(baseline.test_files).toHaveLength(118);
    expect(crosswalk.parent_commit).toBe(inventory.python_reference.commit);
    expect(crosswalk.entries.map((entry) => entry.python_test).sort()).toEqual(
      baseline.test_files.map((entry) => entry.path).sort(),
    );
    expect(crosswalk.feature_coverage).toHaveLength(144);
  });

  it('keeps both fixture directions and provider/catalog differentials synchronized', () => {
    for (const fixture of [pythonCore, pythonCatalogs, pythonProviders]) {
      expect(fixture.generated_by).toBe('python-parent');
      expect(fixture.parent_commit).toBe(inventory.python_reference.commit);
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
      target_parent_commit: inventory.python_reference.commit,
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
      join(repoRoot, 'scripts/generate-test-crosswalk.mjs'),
      join(scratch, 'scripts/generate-test-crosswalk.mjs'),
    );
    cpSync(join(repoRoot, 'scripts/lib'), join(scratch, 'scripts/lib'), { recursive: true });
    symlinkSync(join(repoRoot, 'node_modules'), join(scratch, 'node_modules'), 'junction');
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

  function withInventory(
    mutate: (value: Inventory) => void,
    assertion: (result: ReturnType<typeof check>) => void,
  ) {
    const value = readJson<Inventory>('../../docs/parity-inventory.json');
    mutate(value);
    withCarrier('docs/parity-inventory.json', JSON.stringify(value), () => assertion(check()));
  }

  it('accepts an honest per-feature TypeScript status below frozen Python status', () => {
    withInventory(
      (value) => {
        value.groups[0]!.features[0]!.status = 'partial';
      },
      (result) => {
        expect(result.stderr).toBe('');
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('137/145 fully supported');
      },
    );
  });

  it('accepts another native feature with TypeScript-only evidence and no Python counterpart', () => {
    withInventory(
      (value) => {
        value.groups[0]!.features.push({
          id: 'native.fixture',
          name: 'Native fixture',
          status: 'supported',
          evidence: ['native-fixture'],
        });
        value.evidence['native-fixture'] = { typescript: value.evidence.openrouter!.typescript! };
      },
      (result) => {
        expect(result.stderr).toBe('');
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('139/146 fully supported');
      },
    );
  });

  it('requires explicit scope reasons for declined Python adoption', () => {
    withInventory(
      (value) => {
        const requirement = value.python_requirements[0]!;
        value.groups[0]!.features = value.groups[0]!.features.filter(
          (feature) => feature.id !== requirement.feature_id,
        );
        delete requirement.feature_id;
        requirement.disposition = 'declined';
        requirement.reason = 'Disposable test scope explicitly excludes this behavior.';
      },
      (result) => {
        expect(result.stderr).toBe('');
        expect(result.status).toBe(0);
      },
    );
  });

  it('renders declined Python-only evidence honestly without inventing TypeScript tests', () => {
    withInventory(
      (value) => {
        const ref = 'workspace-agent-registry';
        const requirement = value.python_requirements.find((entry) =>
          entry.evidence.includes(ref),
        )!;
        for (const group of value.groups)
          group.features = group.features.filter(
            (feature) => feature.id !== requirement.feature_id,
          );
        delete requirement.feature_id;
        requirement.disposition = 'declined';
        requirement.reason = 'Disposable scope excludes registry execution.';
        delete value.evidence[ref]!.typescript;
      },
      (result) => {
        expect(result.stderr).toBe('');
        expect(result.status).toBe(0);
        const path = 'docs/parity-test-crosswalk.json';
        withCarrier(path, readFileSync(join(scratch, path), 'utf8'), () => {
          const generated = spawnSync(
            process.execPath,
            [join(scratch, 'scripts/generate-test-crosswalk.mjs')],
            { encoding: 'utf8' },
          );
          expect(generated.stderr).toBe('');
          expect(generated.status).toBe(0);
          const document = JSON.parse(readFileSync(join(scratch, path), 'utf8')) as {
            entries: {
              python_test: string;
              coverage: string;
              typescript_tests: string[];
              notes: string[];
            }[];
          };
          expect(
            document.entries.find(
              (entry) =>
                entry.python_test === 'tests/unit/workspace_agents/test_sqlite_registry.py',
            ),
          ).toMatchObject({
            coverage: 'declined_adoption',
            typescript_tests: [],
            notes: ['Declined adoption: Disposable scope excludes registry execution.'],
          });
        });
      },
    );
  });

  it.each([
    [
      'rewritten legacy ID',
      (value: Inventory) => {
        value.python_requirements[0]!.id = 'parent.traceability.rewritten';
      },
      'does not match its frozen legacy ID',
    ],
    [
      'redirected adopted mapping',
      (value: Inventory) => {
        value.python_requirements[0]!.feature_id = 'extension.openrouter';
      },
      'does not match its canonical TypeScript feature',
    ],
    [
      'unknown status',
      (value: Inventory) => {
        value.groups[0]!.features[0]!.status = 'constructor';
      },
      'Unknown TypeScript status',
    ],
    [
      'missing feature evidence',
      (value: Inventory) => {
        value.groups[0]!.features[0]!.evidence = [];
      },
      'has no evidence references',
    ],
    [
      'missing supplement evidence',
      (value: Inventory) => {
        value.groups.find((group) => group.classification === 'supplement')!.features[0]!.evidence =
          [];
      },
      'has no evidence references',
    ],
    [
      'missing record',
      (value: Inventory) => {
        value.groups[0]!.features[0]!.evidence = ['missing'];
      },
      'Missing evidence record',
    ],
    [
      'missing TS path',
      (value: Inventory) => {
        value.evidence.openrouter!.typescript!.sources = ['src/absent.ts'];
      },
      'references missing path',
    ],
    [
      'missing TS symbol',
      (value: Inventory) => {
        value.evidence.openrouter!.typescript!.symbols = ['absentFixtureSymbol'];
      },
      'cannot resolve symbol',
    ],
    [
      'missing disposition',
      (value: Inventory) => {
        delete value.python_requirements[0]!.disposition;
      },
      'has no valid disposition',
    ],
    [
      'omitted Python requirement',
      (value: Inventory) => {
        value.python_requirements.shift();
      },
      'has no disposition',
    ],
    [
      'changed frozen status',
      (value: Inventory) => {
        value.python_requirements[0]!.status = 'Partial';
      },
      'does not match its frozen baseline',
    ],
    [
      'unsupported without reason',
      (value: Inventory) => {
        delete value.python_requirements.find(
          (requirement) => requirement.disposition === 'unsupported',
        )!.reason;
      },
      'needs a disposition reason',
    ],
  ] as const)('rejects %s', (_label, mutate, message) => {
    withInventory(mutate, (result) => {
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(message);
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
