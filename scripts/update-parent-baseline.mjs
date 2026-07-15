import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import { formatGenerated } from './lib/format-generated.mjs';

const execFileAsync = promisify(execFile);
const inventoryUrl = new URL('../docs/parity-inventory.json', import.meta.url);
const outputUrl = new URL('../docs/parent-baseline.json', import.meta.url);
const inventory = JSON.parse(await readFile(inventoryUrl, 'utf8'));
const parentDir = resolve(requiredArgument('--parent'));

const head = await git('rev-parse', 'HEAD');
if (head !== inventory.parent.commit) {
  throw new Error(`Parent checkout is ${head}; expected pinned commit ${inventory.parent.commit}.`);
}
const treeSha = await git('rev-parse', 'HEAD^{tree}');
const committedAt = await git('show', '-s', '--format=%cI', 'HEAD');
const tree = parseTree(await git('ls-tree', '-r', '--long', 'HEAD'));
const catalog = await readParent(inventory.parent.feature_catalog);
const referencedPaths = new Set([inventory.parent.feature_catalog]);
const unresolvedSymbols = [];

for (const [ref, record] of Object.entries(inventory.evidence)) {
  for (const path of [...record.parent.sources, ...record.parent.tests]) referencedPaths.add(path);
  if (record.parent.sources.length === 0 && record.parent.tests.length === 0) continue;
  const paths = [...record.parent.sources, ...record.parent.tests].filter((path) => tree.has(path));
  const searchable = (await Promise.all(paths.map((path) => readParent(path)))).join('\n');
  for (const symbol of record.parent.symbols) {
    if (!searchable.includes(symbol)) {
      unresolvedSymbols.push(`${ref}:${symbol}`);
    }
  }
}

const missing = [...referencedPaths].filter((path) => !tree.has(path));
if (missing.length > 0) throw new Error(`Parent evidence paths are missing: ${missing.join(', ')}.`);
if (unresolvedSymbols.length > 0) {
  throw new Error(`Parent evidence symbols are unresolved: ${unresolvedSymbols.join(', ')}.`);
}
const testFiles = [...tree.values()]
  .filter((entry) => /^tests\/.*test_.*\.py$/.test(entry.path))
  .map(({ path, blob_sha, size }) => ({ path, blob_sha, size }))
  .sort(byPath);
const evidenceFiles = [...referencedPaths]
  .map((path) => tree.get(path))
  .map(({ path, blob_sha, size }) => ({ path, blob_sha, size }))
  .sort(byPath);
const baseline = {
  schema_version: 1,
  parent_repository: inventory.parent.repository,
  parent_default_branch: inventory.parent.default_branch,
  parent_commit: head,
  parent_tree: treeSha,
  committed_at: committedAt,
  feature_catalog: {
    path: inventory.parent.feature_catalog,
    sha256: createHash('sha256').update(catalog).digest('hex'),
  },
  evidence_files: evidenceFiles,
  test_files: testFiles,
};
const rendered = await formatGenerated(`${JSON.stringify(baseline, null, 2)}\n`, outputUrl);

if (process.argv.includes('--check')) {
  const current = await readFile(outputUrl, 'utf8').catch(() => '');
  if (current !== rendered) {
    throw new Error('docs/parent-baseline.json is stale. Run pnpm parity:update-parent-baseline.');
  }
  console.log(
    `Parent baseline OK: ${head.slice(0, 12)}, ${evidenceFiles.length} evidence files, ${testFiles.length} test modules.`,
  );
} else {
  await writeFile(outputUrl, rendered, 'utf8');
  console.log(
    `Wrote parent baseline: ${head.slice(0, 12)}, ${evidenceFiles.length} evidence files, ${testFiles.length} test modules.`,
  );
}

async function git(...args) {
  const result = await execFileAsync('git', ['-C', parentDir, ...args], {
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024,
  });
  return result.stdout.trim();
}

async function readParent(path) {
  return readFile(resolve(parentDir, ...path.split('/')), 'utf8').catch((cause) => {
    throw new Error(`Cannot read parent path '${path}'.`, { cause });
  });
}

function parseTree(output) {
  const entries = new Map();
  for (const line of output.split(/\r?\n/)) {
    const match = /^(\d+)\s+blob\s+([0-9a-f]{40})\s+(\d+|-)\t(.+)$/.exec(line);
    if (match === null) continue;
    const [, , blob_sha, rawSize, path] = match;
    entries.set(path, { path, blob_sha, size: rawSize === '-' ? null : Number(rawSize) });
  }
  return entries;
}

function requiredArgument(name) {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${name} <path> is required; baseline updates must use an explicit parent checkout.`);
  }
  return value;
}

function byPath(left, right) {
  return left.path.localeCompare(right.path);
}
