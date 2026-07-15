import { readFile, writeFile } from 'node:fs/promises';

import { DOMAIN_EVIDENCE, FEATURE_EVIDENCE, SPECIAL_EVIDENCE } from './lib/parity-evidence.mjs';
import { formatGenerated } from './lib/format-generated.mjs';

const inventoryUrl = new URL('../docs/parity-inventory.json', import.meta.url);
const inventory = JSON.parse(await readFile(inventoryUrl, 'utf8'));

if (inventory.schema_version !== 1 && inventory.schema_version !== 2) {
  throw new Error(`Unsupported parity inventory schema ${String(inventory.schema_version)}.`);
}

const parent =
  inventory.schema_version === 1
    ? {
        repository: inventory.parent_repository,
        default_branch: 'master',
        commit: inventory.parent_commit,
        feature_catalog: 'FEATURES.md',
      }
    : inventory.parent;

const evidence = Object.fromEntries(
  Object.entries(DOMAIN_EVIDENCE).map(([domain, value]) => [slug(domain), value]),
);
Object.assign(evidence, SPECIAL_EVIDENCE);

const seenIds = new Set();
const groups = inventory.groups.map((group) => {
  const classification = group.source === 'FEATURES.md' ? 'parent' : 'supplement';
  const groupId = group.id ?? slug(group.domain);
  const features = group.features.map((entry) => {
    const name = typeof entry === 'string' ? entry : entry.name;
    const id =
      typeof entry === 'string'
        ? `${classification}.${groupId}.${slug(name)}`
        : entry.id;
    if (seenIds.has(id)) throw new Error(`Duplicate parity feature id '${id}'.`);
    seenIds.add(id);
    const evidenceRef = FEATURE_EVIDENCE[name] ?? slug(group.domain);
    if (evidence[evidenceRef] === undefined) {
      throw new Error(`No evidence record '${evidenceRef}' exists for '${name}'.`);
    }
    return { id, name, evidence: [evidenceRef] };
  });
  return {
    id: groupId,
    classification,
    domain: group.domain,
    owner_phase: group.owner_phase,
    parent_status: group.parent_status,
    target_status: group.target_status,
    source: group.source,
    features,
  };
});

const normalized = {
  schema_version: 2,
  parent,
  catalog_unique_feature_count: inventory.catalog_unique_feature_count,
  evidence,
  groups,
  extensions: [
    {
      id: 'extension.openrouter',
      classification: 'extension',
      included_in_python_parity_score: false,
      name: 'OpenRouter aggregator provider',
      rationale: 'TypeScript-only extension; excluded from the Python parity score.',
      evidence: ['openrouter'],
    },
  ],
};

const rendered = await formatGenerated(`${JSON.stringify(normalized, null, 2)}\n`, inventoryUrl);
if (process.argv.includes('--check')) {
  const current = await readFile(inventoryUrl, 'utf8');
  if (current !== rendered) throw new Error('docs/parity-inventory.json is not normalized.');
  console.log(`Parity inventory schema v2 is normalized: ${seenIds.size} requirements.`);
} else {
  await writeFile(inventoryUrl, rendered, 'utf8');
  console.log(`Upgraded parity inventory to schema v2 with ${seenIds.size} stable feature ids.`);
}

function slug(value) {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
