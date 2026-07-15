import { readFile, writeFile } from 'node:fs/promises';

import {
  BUNDLED_PROVIDER_MODEL_CATALOG_VERSION,
  bundledProviderModels,
} from '../dist/providers/catalog.js';
import { BUNDLED_PRICING, BUNDLED_PRICING_VERSION } from '../dist/pricing/index.js';

const outputUrl = new URL('../docs/catalog-snapshot.json', import.meta.url);
const snapshot = {
  schema_version: 1,
  parent_commit: 'f27decbc9aeaae972c5bbeb256c70450b7fe393a',
  provider_models: {
    version: BUNDLED_PROVIDER_MODEL_CATALOG_VERSION,
    entries: bundledProviderModels(),
  },
  pricing: {
    version: BUNDLED_PRICING_VERSION,
    entries: BUNDLED_PRICING.list(),
  },
};
const rendered = `${JSON.stringify(snapshot, null, 2)}\n`;

if (process.argv.includes('--check')) {
  const existing = await readFile(outputUrl, 'utf8').catch(() => '');
  if (existing !== rendered) {
    throw new Error('docs/catalog-snapshot.json is stale. Run pnpm generate:catalog.');
  }
  console.log(
    `Catalog snapshot OK: ${snapshot.provider_models.entries.length} models, ${snapshot.pricing.entries.length} prices.`,
  );
} else {
  await writeFile(outputUrl, rendered, 'utf8');
  console.log(
    `Wrote catalog snapshot: ${snapshot.provider_models.entries.length} models, ${snapshot.pricing.entries.length} prices.`,
  );
}
