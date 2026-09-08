import { access, readFile, writeFile } from 'node:fs/promises';

import { formatGenerated } from './lib/format-generated.mjs';

const inventoryUrl = new URL('../docs/parity-inventory.json', import.meta.url);
const outputUrl = new URL('../docs/PARITY_MATRIX.md', import.meta.url);
const inventory = JSON.parse(await readFile(inventoryUrl, 'utf8'));
if (inventory.schema_version !== 3) throw new Error('Feature matrix requires inventory schema 3.');
const rows = inventory.groups.flatMap((group) =>
  group.features.map((feature) => ({ feature, group })),
);
const features = rows.filter(({ group }) => group.classification === 'feature');
const supplements = rows.filter(({ group }) => group.classification === 'supplement');
const full = features.filter(({ feature }) => feature.status === 'supported').length;
const labels = {
  supported: 'Supported',
  conditional: 'Conditional',
  partial: 'Partial',
  contract: 'Contract only',
  unsupported: 'Unsupported',
};
for (const { feature } of rows) {
  for (const ref of feature.evidence) {
    const evidence = inventory.evidence[ref].typescript;
    await Promise.all(
      [...evidence.sources, ...evidence.tests].map((path) =>
        access(new URL(`../${path}`, import.meta.url)),
      ),
    );
  }
}
const lines = [
  '# TypeScript Feature Matrix',
  '',
  'Generated from `docs/parity-inventory.json` schema v3. Do not edit by hand; run `pnpm generate:parity`.',
  '',
  `TypeScript feature score: **${full}/${features.length} fully supported (${((100 * full) / features.length).toFixed(1)}%)**. The denominator includes native features and unsupported scoped features. **${supplements.length} verification supplements** are separate evidence, excluded from the score.`,
  '',
  'Statuses belong to individual TypeScript features. Conditional, partial, contract-only and unsupported rows do not count as fully supported. Legacy `parent.*` and `extension.*` IDs remain stable identifiers, not ownership or score classifications.',
  '',
  `Status counts: ${Object.entries(labels)
    .map(
      ([status, label]) =>
        `${label}: **${features.filter(({ feature }) => feature.status === status).length}**`,
    )
    .join('; ')}.`,
  '',
  '## TypeScript features',
  '',
];
renderRows(features);
lines.push('', '## Verification supplements (not scored)', '');
renderRows(supplements);
lines.push(
  '',
  '## Frozen Python compatibility dispositions',
  '',
  `Reference: \`${inventory.python_reference.repository}@${inventory.python_reference.commit}\`. Each frozen requirement has an explicit disposition. Adoption does not impose a status floor; TypeScript statuses reflect this implementation. Unsupported adoption stays in scope and in the score. Declined adoption requires a scope reason and has no scored feature.`,
  '',
  '| Legacy requirement ID | Python requirement | Frozen Python status | Disposition | TypeScript feature | Reason | Python evidence |',
  '| --- | --- | --- | --- | --- | --- | --- |',
);
for (const requirement of inventory.python_requirements) {
  const records = requirement.evidence.map((ref) => inventory.evidence[ref]);
  const paths = unique(
    records.flatMap((entry) => [...entry.parent.sources, ...entry.parent.tests]),
  );
  const evidence = paths
    .map(
      (path) =>
        `[\`${escapeCell(path)}\`](https://github.com/${inventory.python_reference.repository}/blob/${inventory.python_reference.commit}/${path})`,
    )
    .join('<br>');
  lines.push(
    `| \`${escapeCell(requirement.id)}\` | ${escapeCell(requirement.name)} | ${escapeCell(requirement.status)} | ${requirement.disposition} | ${requirement.feature_id === undefined ? '—' : `\`${escapeCell(requirement.feature_id)}\``} | ${escapeCell(requirement.reason ?? '—')} | ${evidence} |`,
  );
}
lines.push(
  '',
  '## Maintenance and release evidence',
  '',
  '- [Maintenance procedures](PARITY_MAINTENANCE.md)',
  '- [Frozen Python baseline](parent-baseline.json)',
  '- [Compatibility test crosswalk](parity-test-crosswalk.json)',
  '- [Public API snapshot](public-api.json)',
  '- [Catalog snapshot](catalog-snapshot.json)',
  '- [Package smoke check](../scripts/package-smoke.mjs)',
);
const rendered = await formatGenerated(`${lines.join('\n')}\n`, outputUrl);
if (process.argv.includes('--check')) {
  if ((await readFile(outputUrl, 'utf8').catch(() => '')) !== rendered)
    throw new Error('docs/PARITY_MATRIX.md is stale. Run pnpm generate:parity.');
  console.log(
    `TypeScript feature matrix OK: ${full}/${features.length} fully supported; ${supplements.length} supplements.`,
  );
} else {
  await writeFile(outputUrl, rendered, 'utf8');
  console.log(
    `Wrote TypeScript feature matrix: ${full}/${features.length} fully supported; ${supplements.length} supplements.`,
  );
}
function renderRows(entries) {
  lines.push(
    '| Stable ID | Feature | Domain | TypeScript status | Implementation | Tests |',
    '| --- | --- | --- | --- | --- | --- |',
  );
  for (const { feature, group } of entries) {
    const records = feature.evidence.map((ref) => inventory.evidence[ref].typescript);
    lines.push(
      `| \`${escapeCell(feature.id)}\` | ${escapeCell(feature.name)} | ${escapeCell(group.domain)} | ${labels[feature.status]} | ${renderTsLinks(unique(records.flatMap((entry) => entry.sources)))} | ${renderTsLinks(unique(records.flatMap((entry) => entry.tests)))} |`,
    );
  }
}
function renderTsLinks(paths) {
  return paths
    .map((path) => `[\`${escapeCell(path)}\`](../${path.replaceAll(' ', '%20')})`)
    .join('<br>');
}
function escapeCell(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
}
function unique(values) {
  return [...new Set(values)];
}
