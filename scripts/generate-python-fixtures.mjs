import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { formatGenerated } from './lib/format-generated.mjs';

const execFileAsync = promisify(execFile);
const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const parentDir = resolve(requiredArgument('--parent'));
const inventory = JSON.parse(await readFile(resolve(repoRoot, 'docs/parity-inventory.json'), 'utf8'));
const head = await git('rev-parse', 'HEAD');
if (head !== inventory.parent.commit) {
  throw new Error(`Parent checkout is ${head}; expected pinned commit ${inventory.parent.commit}.`);
}

const check = process.argv.includes('--check');
const outputDir = check
  ? await mkdtemp(resolve(tmpdir(), 'blackbox-ts-python-fixtures-'))
  : resolve(repoRoot, 'tests/fixtures/python');
try {
  const python = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
  await execFileAsync(
    python,
    [
      resolve(repoRoot, 'scripts/python/generate_contract_fixtures.py'),
      '--output',
      outputDir,
      '--parent-commit',
      head,
    ],
    {
      cwd: parentDir,
      env: {
        ...process.env,
        PYTHONPATH: [resolve(parentDir, 'src'), parentDir, process.env.PYTHONPATH]
          .filter(Boolean)
          .join(delimiter),
      },
      windowsHide: true,
      maxBuffer: 20 * 1024 * 1024,
    },
  );
  for (const name of ['core-contracts.json', 'catalogs.json', 'provider-differential.json']) {
    const generatedPath = resolve(outputDir, name);
    const content = await readFile(generatedPath, 'utf8');
    const formatted = await formatGenerated(
      content,
      resolve(repoRoot, 'tests/fixtures/python', name),
    );
    await writeFile(generatedPath, formatted, 'utf8');
  }
  if (check) {
    for (const name of ['core-contracts.json', 'catalogs.json', 'provider-differential.json']) {
      const expected = await readFile(resolve(outputDir, name), 'utf8');
      const current = await readFile(resolve(repoRoot, 'tests/fixtures/python', name), 'utf8').catch(
        () => '',
      );
      if (current !== expected) {
        throw new Error(`tests/fixtures/python/${name} is stale. Regenerate from the pinned parent.`);
      }
    }
    console.log(`Python parity fixtures OK at ${head.slice(0, 12)}.`);
  } else {
    console.log(`Generated Python parity fixtures at ${head.slice(0, 12)}.`);
  }
} finally {
  if (check) await rm(outputDir, { recursive: true, force: true });
}

async function git(...args) {
  const result = await execFileAsync('git', ['-C', parentDir, ...args], {
    windowsHide: true,
  });
  return result.stdout.trim();
}

function requiredArgument(name) {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} <path> is required.`);
  return value;
}
