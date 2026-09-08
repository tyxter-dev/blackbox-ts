import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

import { formatGenerated } from './lib/format-generated.mjs';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const outputPath = resolve(repoRoot, 'tests/fixtures/typescript/core-contracts.json');
// Load current source, not an earlier dist build. Vite is an existing dev dependency;
// middleware mode and ws:false disable HTTP/WebSocket listeners; close on failure too.
const loader = await createServer({
  root: repoRoot,
  configFile: false,
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  appType: 'custom',
});
let fixture;
try {
  const { buildTypeScriptFixture } = await loader.ssrLoadModule(
    '/tests/fixtures/typescript/build-core-fixture.ts',
  );
  fixture = buildTypeScriptFixture();
} finally {
  await loader.close();
}
const rendered = await formatGenerated(`${JSON.stringify(fixture, null, 2)}\n`, outputPath);
if (process.argv.includes('--check')) {
  if ((await readFile(outputPath, 'utf8').catch(() => '')) !== rendered) {
    throw new Error(
      'tests/fixtures/typescript/core-contracts.json is stale. Run pnpm generate:parity:ts and review the changed expectations.',
    );
  }
  console.log('Canonical TypeScript fixture matches current source.');
} else {
  await mkdir(resolve(repoRoot, 'tests/fixtures/typescript'), { recursive: true });
  await writeFile(outputPath, rendered, 'utf8');
  console.log('Generated canonical TypeScript fixture; review changes before accepting.');
}
