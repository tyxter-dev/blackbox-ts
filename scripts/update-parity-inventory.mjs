import { readFile, writeFile } from 'node:fs/promises';

import { DOMAIN_EVIDENCE, SPECIAL_EVIDENCE } from './lib/parity-evidence.mjs';
import { formatGenerated } from './lib/format-generated.mjs';

const inventoryUrl = new URL('../docs/parity-inventory.json', import.meta.url);
const inventory = JSON.parse(await readFile(inventoryUrl, 'utf8'));
if (inventory.schema_version !== 3) {
  throw new Error(
    `Unsupported parity inventory schema ${String(inventory.schema_version)}; expected 3.`,
  );
}
// Status, scope and evidence bindings belong to the TypeScript inventory author.
// Normalization refreshes evidence definitions without deriving feature policy from Python.
const evidence = Object.fromEntries(
  Object.entries(DOMAIN_EVIDENCE).map(([domain, value]) => [slug(domain), value]),
);
Object.assign(evidence, SPECIAL_EVIDENCE);
const normalized = { ...inventory, evidence };
const rendered = await formatGenerated(`${JSON.stringify(normalized, null, 2)}\n`, inventoryUrl);
if (process.argv.includes('--check')) {
  if ((await readFile(inventoryUrl, 'utf8')) !== rendered)
    throw new Error('docs/parity-inventory.json is not normalized.');
  console.log('TypeScript feature inventory schema v3 is normalized.');
} else {
  await writeFile(inventoryUrl, rendered, 'utf8');
  console.log('Normalized TypeScript feature inventory schema v3.');
}
function slug(value) {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
