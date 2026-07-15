import { execFile } from 'node:child_process';
import { access, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { formatGenerated } from './lib/format-generated.mjs';

const execFileAsync = promisify(execFile);
const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const outputPath = resolve(repoRoot, 'docs/parity-test-crosswalk.json');
const inventory = JSON.parse(await readFile(resolve(repoRoot, 'docs/parity-inventory.json'), 'utf8'));
const baseline = JSON.parse(await readFile(resolve(repoRoot, 'docs/parent-baseline.json'), 'utf8'));
const parentTests = baseline.test_files.map((entry) => entry.path).sort();
const parentGroups = inventory.groups.filter((group) => group.classification === 'parent');
const parentDomains = [...new Set(parentGroups.map((group) => group.domain))];

const explicitEvidence = new Map();
for (const [ref, evidence] of Object.entries(inventory.evidence)) {
  for (const pythonTest of evidence.parent.tests) {
    const entry = explicitEvidence.get(pythonTest) ?? { refs: [], typescript: new Set() };
    entry.refs.push(ref);
    for (const test of evidence.typescript.tests) entry.typescript.add(test);
    explicitEvidence.set(pythonTest, entry);
  }
}

if (process.argv.includes('--parent')) await validateParentCheckout(parentTests);

const entries = parentTests.map((pythonTest) => {
  const explicit = explicitEvidence.get(pythonTest);
  const domains = explicit?.refs.map(domainForEvidence).filter(unique) ?? [];
  const inferred = inferMapping(pythonTest);
  return {
    id: `python-test.${slug(pythonTest)}`,
    python_test: pythonTest,
    classification: classify(pythonTest),
    coverage: explicit === undefined ? 'semantic_projection' : 'direct_evidence',
    domains: domains.length === 0 ? inferred.domains : domains,
    evidence_refs: explicit?.refs ?? [],
    typescript_tests:
      explicit === undefined ? inferred.tests : [...explicit.typescript].sort(),
  };
});

const missingDomains = parentDomains.filter(
  (domain) => !entries.some((entry) => entry.domains.includes(domain)),
);
if (missingDomains.length > 0) {
  throw new Error(`Crosswalk has no Python test coverage for domains: ${missingDomains.join(', ')}.`);
}
for (const entry of entries) {
  if (entry.typescript_tests.length === 0) throw new Error(`${entry.python_test} has no TS tests.`);
  for (const test of entry.typescript_tests) {
    await access(resolve(repoRoot, ...test.split('/'))).catch(() => {
      throw new Error(`${entry.python_test} references missing TypeScript test ${test}.`);
    });
  }
}

const classifications = Object.fromEntries(
  ['semantic', 'sdk_protocol_fixture', 'integration_smoke', 'partial_contract_negative'].map(
    (classification) => [
      classification,
      entries.filter((entry) => entry.classification === classification).length,
    ],
  ),
);
const document = {
  schema_version: 1,
  parent_repository: inventory.parent.repository,
  parent_commit: inventory.parent.commit,
  generated_from: 'docs/parent-baseline.json',
  summary: {
    python_test_modules: entries.length,
    direct_evidence: entries.filter((entry) => entry.coverage === 'direct_evidence').length,
    semantic_projections: entries.filter((entry) => entry.coverage === 'semantic_projection').length,
    domains_covered: parentDomains.length,
    classifications,
  },
  entries,
  feature_coverage: parentGroups.flatMap((group) =>
    group.features.map((feature) => {
      const evidenceRef = feature.evidence[0];
      return {
        feature_id: feature.id,
        domain: group.domain,
        evidence_ref: evidenceRef,
        typescript_tests: inventory.evidence[evidenceRef].typescript.tests,
      };
    }),
  ),
};
if (document.feature_coverage.length !== inventory.catalog_unique_feature_count) {
  throw new Error('Crosswalk feature coverage does not match the parent feature inventory.');
}
const rendered = await formatGenerated(`${JSON.stringify(document, null, 2)}\n`, outputPath);

if (process.argv.includes('--check')) {
  const current = await readFile(outputPath, 'utf8').catch(() => '');
  if (current !== rendered) {
    throw new Error('docs/parity-test-crosswalk.json is stale. Run pnpm generate:parity:crosswalk.');
  }
  console.log(
    `Parity test crosswalk OK: ${entries.length} Python test modules, ${parentDomains.length} domains, ${document.feature_coverage.length} parent features.`,
  );
} else {
  await writeFile(outputPath, rendered, 'utf8');
  console.log(
    `Wrote parity test crosswalk: ${entries.length} Python test modules, ${parentDomains.length} domains.`,
  );
}

async function validateParentCheckout(expectedTests) {
  const parentDir = resolve(requiredArgument('--parent'));
  const head = (
    await execFileAsync('git', ['-C', parentDir, 'rev-parse', 'HEAD'], { windowsHide: true })
  ).stdout.trim();
  if (head !== inventory.parent.commit) {
    throw new Error(`Parent checkout is ${head}; expected pinned commit ${inventory.parent.commit}.`);
  }
  const tracked = (
    await execFileAsync('git', ['-C', parentDir, 'ls-files', 'tests'], {
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    })
  ).stdout
    .split(/\r?\n/)
    .filter((path) => /^tests\/.*test_.*\.py$/.test(path))
    .sort();
  if (JSON.stringify(tracked) !== JSON.stringify(expectedTests)) {
    throw new Error('Parent test modules differ from docs/parent-baseline.json.');
  }
}

function classify(path) {
  if (path.startsWith('tests/golden/')) return 'sdk_protocol_fixture';
  if (path.startsWith('tests/journey/') || path.includes('/smoke/')) return 'integration_smoke';
  if (/capabilit|unsupported|validation|security|error|approval|policy/.test(path)) {
    return 'partial_contract_negative';
  }
  return 'semantic';
}

function inferMapping(path) {
  const rules = [
    [/golden\/(openai|anthropic|gemini)/, ['Native Model Providers'], ['tests/golden/python-provider-differential.test.ts', 'tests/golden/providers.test.ts']],
    [/model_catalog|bundled_model|pricing|accounting/, ['Provider Controls and Catalog', 'Accounting and Cache'], ['tests/golden/python-catalog-differential.test.ts', 'tests/unit/registry-catalog.test.ts', 'tests/unit/planning-accounting-config.test.ts']],
    [/workspace_agents/, ['Skills and Workspace Agents', 'Package and Worker Hardening'], ['tests/unit/workspace-agents.test.ts']],
    [/workspaces|workspace_provider/, ['Workspaces', 'Workspace Providers and Security'], ['tests/unit/workspaces.test.ts', 'tests/security/boundaries.test.ts']],
    [/mcp/, ['MCP', 'MCP Lifecycle Security'], ['tests/unit/mcp.test.ts', 'tests/security/boundaries.test.ts']],
    [/realtime/, ['Realtime'], ['tests/unit/realtime.test.ts']],
    [/session|agents\//, ['Agent Sessions'], ['tests/unit/agent-sessions.test.ts']],
    [/worker|work_source/, ['Environment Workers'], ['tests/unit/workers-observability.test.ts']],
    [/observability|trace|sink/, ['Observability'], ['tests/unit/workers-observability.test.ts', 'tests/unit/persistence-observability.test.ts']],
    [/store|persist|resume|serializ/, ['Persistence', 'Persistence Contracts'], ['tests/unit/persistence-observability.test.ts', 'tests/golden/core-contracts.test.ts']],
    [/artifact/, ['Artifacts'], ['tests/unit/core-contracts.test.ts']],
    [/prompt/, ['Prompt Planning'], ['tests/unit/planning-accounting-config.test.ts']],
    [/config|workflow_profile/, ['Runtime Configuration'], ['tests/unit/planning-accounting-config.test.ts']],
    [/output|schema/, ['Structured Output'], ['tests/unit/tools-output.test.ts', 'tests/unit/agent-loop.test.ts']],
    [/hosted/, ['Hosted Tools'], ['tests/golden/providers.test.ts', 'tests/unit/agent-loop.test.ts']],
    [/tool/, ['Local Tools'], ['tests/unit/tools-output.test.ts', 'tests/unit/agent-loop.test.ts']],
    [/capabilit/, ['Granular Model Capabilities'], ['tests/unit/capabilities.test.ts', 'tests/unit/provider-contracts.test.ts']],
    [/provider|model_adapter/, ['Provider Runtime'], ['tests/unit/provider-contracts.test.ts', 'tests/unit/model-runtime.test.ts']],
    [/approval|policy|guardrail|safety/, ['Policy, Approvals, and Safety'], ['tests/unit/core-contracts.test.ts', 'tests/unit/agent-loop.test.ts']],
    [/core/, ['Core Events and State'], ['tests/golden/core-contracts.test.ts', 'tests/unit/core-contracts.test.ts']],
    [/runtime/, ['High-Level Runtime', 'Runtime Lifecycle Hardening'], ['tests/unit/agent-loop.test.ts', 'tests/journey/runtime-journey.test.ts']],
  ];
  for (const [pattern, domains, tests] of rules) {
    if (pattern.test(path)) return { domains, tests };
  }
  return {
    domains: ['High-Level Runtime'],
    tests: ['tests/journey/runtime-journey.test.ts'],
  };
}

function domainForEvidence(ref) {
  return inventory.groups.find(
    (group) =>
      group.classification === 'parent' &&
      (group.id === ref || group.features.some((feature) => feature.evidence.includes(ref))),
  )?.domain;
}

function slug(value) {
  return value
    .replace(/^tests\//, '')
    .replace(/\.py$/, '')
    .replace(/[^a-z0-9]+/gi, '.')
    .replace(/^\.|\.$/g, '')
    .toLowerCase();
}

function unique(value, index, values) {
  return value !== undefined && values.indexOf(value) === index;
}

function requiredArgument(name) {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} <path> is required.`);
  return value;
}
