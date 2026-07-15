import { readFile } from 'node:fs/promises';

const inventoryUrl = new URL('../docs/parity-inventory.json', import.meta.url);
const inventory = JSON.parse(await readFile(inventoryUrl, 'utf8'));
const catalog = inventory.groups
  .filter((group) => group.source === 'FEATURES.md')
  .flatMap((group) => group.features);
const supplements = inventory.groups
  .filter((group) => group.source === 'implementation supplement')
  .flatMap((group) => group.features);
const uniqueCatalog = new Set(catalog);
const catalogStatuses = Object.fromEntries(
  Object.entries(
    inventory.groups
      .filter((group) => group.source === 'FEATURES.md')
      .reduce((counts, group) => {
        counts[group.parent_status] = (counts[group.parent_status] ?? 0) + group.features.length;
        return counts;
      }, {}),
  ).sort(([left], [right]) => left.localeCompare(right)),
);
const expectedCatalogStatuses = {
  'Contract only': 2,
  'Not supported yet': 1,
  Partial: 3,
  Supported: 136,
  'Supported where advertised': 1,
};

if (catalog.length !== uniqueCatalog.size) {
  const duplicates = catalog.filter((feature, index) => catalog.indexOf(feature) !== index);
  throw new Error(`Parity inventory contains duplicate catalog features: ${duplicates.join(', ')}`);
}
if (uniqueCatalog.size !== inventory.catalog_unique_feature_count) {
  throw new Error(
    `Parity inventory expected ${inventory.catalog_unique_feature_count} unique catalog features, found ${uniqueCatalog.size}.`,
  );
}
if (!/^[0-9a-f]{40}$/.test(inventory.parent_commit)) {
  throw new Error('Parity inventory must pin a full 40-character parent commit.');
}
if (JSON.stringify(catalogStatuses) !== JSON.stringify(expectedCatalogStatuses)) {
  throw new Error(
    `Parent status inventory drifted: expected ${JSON.stringify(expectedCatalogStatuses)}, found ${JSON.stringify(catalogStatuses)}.`,
  );
}
if (supplements.length < 3) {
  throw new Error('Parity inventory must track realtime, runtime configuration, and prompt planning.');
}
for (const group of inventory.groups) {
  if (!Number.isInteger(group.owner_phase) || group.owner_phase < 0 || group.owner_phase > 12) {
    throw new Error(`Invalid owner phase for '${group.domain}'.`);
  }
  if (!group.parent_status || !group.target_status || group.features.length === 0) {
    throw new Error(`Incomplete parity group '${group.domain}'.`);
  }
  if (group.target_status !== group.parent_status) {
    throw new Error(
      `Target status for '${group.domain}' must match the pinned parent status unless a reviewed conservative-status rule is added.`,
    );
  }
}

console.log(
  `Parity inventory OK: ${uniqueCatalog.size} catalog features + ${supplements.length} supplements.`,
);
