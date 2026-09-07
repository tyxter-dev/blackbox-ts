import { access, readFile } from 'node:fs/promises';

const inventoryUrl = new URL('../docs/parity-inventory.json', import.meta.url);
const baselineUrl = new URL('../docs/parent-baseline.json', import.meta.url);
const inventory = JSON.parse(await readFile(inventoryUrl, 'utf8'));

if (inventory.schema_version !== 2) {
  throw new Error(`Parity inventory must use schema 2, found ${String(inventory.schema_version)}.`);
}
if (!/^[0-9a-f]{40}$/.test(inventory.parent?.commit ?? '')) {
  throw new Error('Parity inventory must pin a full 40-character parent commit.');
}
for (const field of ['repository', 'default_branch', 'feature_catalog']) {
  if (typeof inventory.parent?.[field] !== 'string' || inventory.parent[field].length === 0) {
    throw new Error(`Parity inventory parent.${field} is required.`);
  }
}

const rows = inventory.groups.flatMap((group) =>
  group.features.map((feature) => ({ ...feature, group })),
);
const parentRows = rows.filter((row) => row.group.classification === 'parent');
const supplements = rows.filter((row) => row.group.classification === 'supplement');
const ids = new Set(rows.map((row) => row.id));
if (ids.size !== rows.length) throw new Error('Parity inventory contains duplicate feature ids.');
if (parentRows.length !== inventory.catalog_unique_feature_count || parentRows.length !== 144) {
  throw new Error(`Parity inventory expected 144 parent features, found ${parentRows.length}.`);
}
if (supplements.length !== 26) {
  throw new Error(
    `Parity inventory expected 26 implementation supplements, found ${supplements.length}.`,
  );
}

// Direction lock: the TypeScript target status may equal or exceed the pinned
// parent status but never fall below it. Equal statuses stay valid.
const STATUS_RANK = {
  'Not supported yet': 0,
  'Contract only': 1,
  Partial: 2,
  'Supported where advertised': 3,
  Supported: 4,
};

const expectedParentStatuses = {
  'Contract only': 2,
  'Not supported yet': 1,
  Partial: 3,
  Supported: 137,
  'Supported where advertised': 1,
};
const parentStatuses = orderedCounts(parentRows.map((row) => row.group.parent_status));
if (JSON.stringify(parentStatuses) !== JSON.stringify(expectedParentStatuses)) {
  throw new Error(
    `Parent status inventory drifted: expected ${JSON.stringify(expectedParentStatuses)}, found ${JSON.stringify(parentStatuses)}.`,
  );
}

for (const group of inventory.groups) {
  if (!['parent', 'supplement'].includes(group.classification)) {
    throw new Error(`Invalid classification for '${group.id}'.`);
  }
  if (!Number.isInteger(group.owner_phase) || group.owner_phase < 0 || group.owner_phase > 12) {
    throw new Error(`Invalid owner phase for '${group.domain}'.`);
  }
  for (const field of ['parent_status', 'target_status']) {
    if (!Object.hasOwn(STATUS_RANK, group[field])) {
      throw new Error(`Unknown ${field} '${String(group[field])}' for '${group.domain}'.`);
    }
  }
  if (STATUS_RANK[group.target_status] < STATUS_RANK[group.parent_status]) {
    throw new Error(
      `Target status '${group.target_status}' for '${group.domain}' regresses below the pinned parent status '${group.parent_status}'.`,
    );
  }
  for (const feature of group.features) {
    const expectedPrefix = `${group.classification}.${group.id}.`;
    if (!feature.id.startsWith(expectedPrefix)) {
      throw new Error(`Feature '${feature.id}' must start with '${expectedPrefix}'.`);
    }
    if (typeof feature.name !== 'string' || feature.name.length === 0) {
      throw new Error(`Feature '${feature.id}' has no display name.`);
    }
    if (!Array.isArray(feature.evidence) || feature.evidence.length === 0) {
      throw new Error(`Feature '${feature.id}' has no evidence references.`);
    }
  }
}

if (!Array.isArray(inventory.extensions) || inventory.extensions.length === 0) {
  throw new Error('TypeScript extensions must be enumerated outside the parent parity score.');
}
for (const extension of inventory.extensions) {
  if (extension.classification !== 'extension' || !extension.id.startsWith('extension.')) {
    throw new Error(`Invalid extension boundary record '${String(extension.id)}'.`);
  }
  if (extension.included_in_python_parity_score !== false) {
    throw new Error(`Extension '${extension.id}' must be excluded from the Python parity score.`);
  }
}

const evidenceRefs = new Set([
  ...rows.flatMap((row) => row.evidence),
  ...inventory.extensions.flatMap((extension) => extension.evidence),
]);
for (const ref of evidenceRefs) {
  const record = inventory.evidence[ref];
  if (record === undefined) throw new Error(`Missing evidence record '${ref}'.`);
  await validateEvidence(
    ref,
    record,
    inventory.extensions.some((item) => item.evidence.includes(ref)),
  );
}
const unusedEvidence = Object.keys(inventory.evidence).filter((ref) => !evidenceRefs.has(ref));
if (unusedEvidence.length > 0) {
  throw new Error(`Unused parity evidence records: ${unusedEvidence.join(', ')}.`);
}

// Pin guard: workflows no longer check out Python. The inventory supplies the
// reference pin to generators; enforce it on the current machine-readable
// carriers below. Historical prose retains its original baselines. Missing or
// unreadable carriers fail closed.
const baseline = await readJson(baselineUrl, 'docs/parent-baseline.json');
if (baseline.parent_commit !== inventory.parent.commit) {
  throw new Error('Parent baseline and parity inventory commits do not match.');
}
if (baseline.parent_repository !== inventory.parent.repository) {
  throw new Error('Parent baseline and parity inventory repositories do not match.');
}
const parentPaths = new Set(baseline.evidence_files.map((entry) => entry.path));
for (const ref of evidenceRefs) {
  for (const path of [
    ...inventory.evidence[ref].parent.sources,
    ...inventory.evidence[ref].parent.tests,
  ]) {
    if (!parentPaths.has(path)) {
      throw new Error(`Parent evidence '${path}' from '${ref}' is absent from the baseline.`);
    }
  }
}

const PIN_CARRIERS = [
  ['docs/parity-test-crosswalk.json', 'parent_commit'],
  ['docs/catalog-snapshot.json', 'parent_commit'],
  ['tests/fixtures/python/core-contracts.json', 'parent_commit'],
  ['tests/fixtures/python/catalogs.json', 'parent_commit'],
  ['tests/fixtures/python/provider-differential.json', 'parent_commit'],
  ['tests/fixtures/typescript/core-contracts.json', 'target_parent_commit'],
];
for (const [path, field] of PIN_CARRIERS) {
  const carrier = await readJson(new URL(`../${path}`, import.meta.url), path);
  if (carrier[field] !== inventory.parent.commit) {
    throw new Error(
      `${path} records ${field} '${String(carrier[field])}', expected the pinned parent commit ${inventory.parent.commit}.`,
    );
  }
}

console.log(
  `Parity inventory OK: ${parentRows.length} parent features (${parentStatuses.Supported} supported, 1 conditional, 6 honest non-full statuses), ${supplements.length} supplements, ${inventory.extensions.length} excluded extension; pin ${inventory.parent.commit.slice(0, 12)} enforced on the baseline and ${PIN_CARRIERS.length} fixture/artifact headers.`,
);

async function readJson(url, label) {
  const contents = await readFile(url, 'utf8').catch((cause) => {
    throw new Error(`Required parity pin carrier '${label}' is missing or unreadable.`, { cause });
  });
  try {
    return JSON.parse(contents);
  } catch (cause) {
    throw new Error(`Parity pin carrier '${label}' is not valid JSON.`, { cause });
  }
}

async function validateEvidence(ref, record, extensionOnly) {
  for (const side of ['parent', 'typescript']) {
    const value = record[side];
    if (value === undefined) throw new Error(`Evidence '${ref}' is missing '${side}'.`);
    for (const field of ['sources', 'tests', 'symbols']) {
      if (!Array.isArray(value[field]))
        throw new Error(`Evidence '${ref}.${side}.${field}' must be an array.`);
    }
  }
  if (!extensionOnly && (record.parent.sources.length === 0 || record.parent.tests.length === 0)) {
    throw new Error(`Parent parity evidence '${ref}' must include source and test paths.`);
  }
  if (record.typescript.sources.length === 0 || record.typescript.tests.length === 0) {
    throw new Error(`TypeScript evidence '${ref}' must include source and test paths.`);
  }
  const sourceContents = [];
  for (const path of [...record.typescript.sources, ...record.typescript.tests]) {
    const url = new URL(`../${path}`, import.meta.url);
    await access(url).catch(() => {
      throw new Error(`TypeScript evidence '${ref}' references missing path '${path}'.`);
    });
    sourceContents.push(await readFile(url, 'utf8'));
  }
  const searchable = sourceContents.join('\n');
  for (const symbol of record.typescript.symbols) {
    if (!searchable.includes(symbol)) {
      throw new Error(`TypeScript evidence '${ref}' cannot resolve symbol '${symbol}'.`);
    }
  }
}

function orderedCounts(values) {
  return Object.fromEntries(
    Object.entries(
      values.reduce((counts, value) => {
        counts[value] = (counts[value] ?? 0) + 1;
        return counts;
      }, {}),
    ).sort(([left], [right]) => left.localeCompare(right)),
  );
}
