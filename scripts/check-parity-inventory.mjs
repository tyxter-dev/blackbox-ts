import { access, readFile } from 'node:fs/promises';

const inventoryUrl = new URL('../docs/parity-inventory.json', import.meta.url);
const baselineUrl = new URL('../docs/parent-baseline.json', import.meta.url);
const inventory = JSON.parse(await readFile(inventoryUrl, 'utf8'));
if (inventory.schema_version !== 3) throw new Error('Feature inventory must use schema 3.');
if (!/^[0-9a-f]{40}$/.test(inventory.python_reference?.commit ?? '')) {
  throw new Error('Feature inventory must pin a full 40-character Python reference commit.');
}
for (const field of ['repository', 'default_branch', 'feature_catalog']) {
  if (
    typeof inventory.python_reference?.[field] !== 'string' ||
    inventory.python_reference[field].length === 0
  ) {
    throw new Error(`Feature inventory python_reference.${field} is required.`);
  }
}
if (
  Object.hasOwn(inventory, 'extensions') ||
  Object.hasOwn(inventory, 'catalog_unique_feature_count')
) {
  throw new Error('Retired Python score/extension fields are not allowed.');
}
const statuses = new Set(['supported', 'conditional', 'partial', 'contract', 'unsupported']);
const rows = inventory.groups.flatMap((group) =>
  group.features.map((feature) => ({ ...feature, group })),
);
const features = rows.filter((row) => row.group.classification === 'feature');
const supplements = rows.filter((row) => row.group.classification === 'supplement');
const ids = new Set();
const groupIds = new Set();
for (const group of inventory.groups) {
  if (!['feature', 'supplement'].includes(group.classification))
    throw new Error(`Invalid classification for '${group.id}'.`);
  if (typeof group.id !== 'string' || !group.id || groupIds.has(group.id))
    throw new Error('Missing or duplicate group id.');
  groupIds.add(group.id);
  if (typeof group.domain !== 'string' || !group.domain)
    throw new Error(`Missing domain for '${group.id}'.`);
  if (Object.hasOwn(group, 'parent_status') || Object.hasOwn(group, 'target_status'))
    throw new Error('Group status defaults are retired; declare each TypeScript feature status.');
  for (const feature of group.features) {
    if (typeof feature.id !== 'string' || !feature.id || ids.has(feature.id))
      throw new Error(`Missing or duplicate feature id '${feature.id}'.`);
    ids.add(feature.id);
    if (typeof feature.name !== 'string' || !feature.name)
      throw new Error(`Feature '${feature.id}' has no display name.`);
    if (!statuses.has(feature.status))
      throw new Error(`Unknown TypeScript status '${String(feature.status)}' for '${feature.id}'.`);
    if (!Array.isArray(feature.evidence) || feature.evidence.length === 0)
      throw new Error(`Feature '${feature.id}' has no evidence references.`);
  }
}
if (features.length === 0) throw new Error('TypeScript feature score cannot be empty.');
const baseline = await readJson(baselineUrl, 'docs/parent-baseline.json');
const frozen = baseline.feature_catalog.requirements;
if (!Array.isArray(frozen) || frozen.length === 0)
  throw new Error('Baseline must enumerate frozen Python requirements.');
if (!Array.isArray(inventory.python_requirements))
  throw new Error('Python compatibility dispositions are required.');
const requirements = inventory.python_requirements;
const requirementNames = new Set();
const requirementIds = new Set();
const featureIds = new Set(features.map((feature) => feature.id));
for (const requirement of requirements) {
  if (typeof requirement.id !== 'string' || !requirement.id || requirementIds.has(requirement.id))
    throw new Error('Missing or duplicate Python requirement id.');
  requirementIds.add(requirement.id);
  if (requirementNames.has(requirement.name))
    throw new Error(`Duplicate Python requirement '${requirement.name}'.`);
  requirementNames.add(requirement.name);
  const source = frozen.find((entry) => entry.name === requirement.name);
  if (source === undefined || source.status !== requirement.status)
    throw new Error(`Python requirement '${requirement.name}' does not match its frozen baseline.`);
  if (
    typeof source.typescript_legacy_id !== 'string' ||
    requirement.id !== source.typescript_legacy_id
  ) {
    throw new Error(
      `Python requirement '${requirement.name}' does not match its frozen legacy ID.`,
    );
  }
  if (!['adopted', 'unsupported', 'declined'].includes(requirement.disposition))
    throw new Error(`Python requirement '${requirement.id}' has no valid disposition.`);
  if (!Array.isArray(requirement.evidence) || requirement.evidence.length === 0)
    throw new Error(`Python requirement '${requirement.id}' has no evidence.`);
  if (typeof requirement.domain !== 'string' || !requirement.domain)
    throw new Error(`Python requirement '${requirement.id}' has no domain.`);
  if (requirement.disposition === 'declined') {
    if (requirement.feature_id !== undefined)
      throw new Error('Declined adoption must not reference a scored feature.');
  } else if (requirement.feature_id !== source.typescript_legacy_id) {
    throw new Error(
      `Python requirement '${requirement.id}' does not match its canonical TypeScript feature.`,
    );
  } else if (!featureIds.has(requirement.feature_id)) {
    throw new Error(`Python requirement '${requirement.id}' must reference a TypeScript feature.`);
  }
  if (
    requirement.disposition !== 'adopted' &&
    (typeof requirement.reason !== 'string' || !requirement.reason.trim())
  )
    throw new Error(`Python requirement '${requirement.id}' needs a disposition reason.`);
  if (
    requirement.disposition === 'unsupported' &&
    features.find((feature) => feature.id === requirement.feature_id)?.status !== 'unsupported'
  )
    throw new Error('Unsupported adoption must retain an unsupported TypeScript feature.');
}
for (const requirement of frozen) {
  if (!requirementNames.has(requirement.name))
    throw new Error(`Frozen Python requirement '${requirement.name}' has no disposition.`);
}
const pythonEvidence = new Set(requirements.flatMap((requirement) => requirement.evidence));
const evidenceRefs = new Set([...rows.flatMap((row) => row.evidence), ...pythonEvidence]);
for (const ref of evidenceRefs) {
  const record = Object.hasOwn(inventory.evidence, ref) ? inventory.evidence[ref] : undefined;
  if (record === undefined) throw new Error(`Missing evidence record '${ref}'.`);
  await validateEvidence(
    ref,
    record,
    pythonEvidence.has(ref),
    rows.some((row) => row.evidence.includes(ref)),
  );
}
const unusedEvidence = Object.keys(inventory.evidence).filter((ref) => !evidenceRefs.has(ref));
if (unusedEvidence.length > 0)
  throw new Error(`Unused parity evidence records: ${unusedEvidence.join(', ')}.`);
if (baseline.parent_commit !== inventory.python_reference.commit) {
  throw new Error('Parent baseline and parity inventory commits do not match.');
}
if (baseline.parent_repository !== inventory.python_reference.repository) {
  throw new Error('Parent baseline and parity inventory repositories do not match.');
}
const parentPaths = new Set(baseline.evidence_files.map((entry) => entry.path));
for (const ref of evidenceRefs) {
  for (const path of [
    ...(inventory.evidence[ref].parent?.sources ?? []),
    ...(inventory.evidence[ref].parent?.tests ?? []),
  ]) {
    if (!parentPaths.has(path)) {
      throw new Error(`Parent evidence '${path}' from '${ref}' is absent from the baseline.`);
    }
  }
}

const PIN_CARRIERS = [
  ['docs/parity-test-crosswalk.json', 'python_reference_commit'],
  ['docs/catalog-snapshot.json', 'parent_commit'],
  ['tests/fixtures/python/core-contracts.json', 'parent_commit'],
  ['tests/fixtures/python/catalogs.json', 'parent_commit'],
  ['tests/fixtures/python/provider-differential.json', 'parent_commit'],
  ['tests/fixtures/python/workspace-agent-package.json', 'parent_commit'],
];
for (const [path, field] of PIN_CARRIERS) {
  const carrier = await readJson(new URL(`../${path}`, import.meta.url), path);
  if (carrier[field] !== inventory.python_reference.commit) {
    throw new Error(
      `${path} records ${field} '${String(carrier[field])}', expected the pinned parent commit ${inventory.python_reference.commit}.`,
    );
  }
}

console.log(
  `TypeScript feature inventory OK: ${features.filter((feature) => feature.status === 'supported').length}/${features.length} fully supported; ${supplements.length} verification supplements excluded; ${requirements.length} Python dispositions; pin ${inventory.python_reference.commit.slice(0, 12)} enforced on the baseline and ${PIN_CARRIERS.length} fixture/artifact headers.`,
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

async function validateEvidence(ref, record, requiresPython, requiresTypeScript) {
  for (const side of ['parent', 'typescript']) {
    const value = record[side];
    if (side === 'parent' && !requiresPython && value === undefined) continue;
    if (side === 'typescript' && !requiresTypeScript && value === undefined) continue;
    if (value === undefined) throw new Error(`Evidence '${ref}' is missing '${side}'.`);
    for (const field of ['sources', 'tests', 'symbols']) {
      if (!Array.isArray(value[field]))
        throw new Error(`Evidence '${ref}.${side}.${field}' must be an array.`);
    }
  }
  if (requiresPython && (record.parent.sources.length === 0 || record.parent.tests.length === 0)) {
    throw new Error(`Parent parity evidence '${ref}' must include source and test paths.`);
  }
  if (!requiresTypeScript) return;
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
