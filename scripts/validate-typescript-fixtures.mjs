import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { delimiter, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const parentDir = resolve(requiredArgument('--parent'));
const inventory = JSON.parse(await readFile(resolve(repoRoot, 'docs/parity-inventory.json'), 'utf8'));
const head = (
  await execFileAsync('git', ['-C', parentDir, 'rev-parse', 'HEAD'], { windowsHide: true })
).stdout.trim();
if (head !== inventory.parent.commit) {
  throw new Error(`Parent checkout is ${head}; expected pinned commit ${inventory.parent.commit}.`);
}
const python = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const result = await execFileAsync(
  python,
  [
    resolve(repoRoot, 'scripts/python/validate_typescript_fixtures.py'),
    '--fixture',
    resolve(repoRoot, 'tests/fixtures/typescript/core-contracts.json'),
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
    maxBuffer: 10 * 1024 * 1024,
  },
);
process.stdout.write(result.stdout);

function requiredArgument(name) {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} <path> is required.`);
  return value;
}
