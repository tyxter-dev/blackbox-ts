import { readFile, writeFile } from 'node:fs/promises';
import ts from 'typescript';

const root = new URL('../', import.meta.url);
const packageJson = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const outputUrl = new URL('docs/public-api.json', root);
const entryPath = new URL('src/index.ts', root).pathname.replace(/^\/(.:\/)/, '$1');
const program = ts.createProgram([entryPath], {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  strict: true,
  skipLibCheck: true,
});
const checker = program.getTypeChecker();
const entry = program.getSourceFile(entryPath);
if (entry === undefined || entry.symbol === undefined) throw new Error('Could not load src/index.ts for API snapshot.');
const symbols = checker
  .getExportsOfModule(entry.symbol)
  .map((symbol) => symbol.getName())
  .filter((name) => name !== 'default')
  .sort();
const snapshot = {
  schema_version: 1,
  package: packageJson.name,
  exports: Object.keys(packageJson.exports).sort(),
  root_symbols: symbols,
};
const rendered = `${JSON.stringify(snapshot, null, 2)}\n`;

if (process.argv.includes('--check')) {
  const current = await readFile(outputUrl, 'utf8').catch(() => '');
  if (current !== rendered) throw new Error('docs/public-api.json is stale. Run pnpm generate:api.');
  console.log(`Public API snapshot OK: ${symbols.length} root symbols, ${snapshot.exports.length} subpaths.`);
} else {
  await writeFile(outputUrl, rendered, 'utf8');
  console.log(`Wrote public API snapshot with ${symbols.length} root symbols.`);
}
