import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const parent = requiredArgument('--parent');

await run('scripts/update-parent-baseline.mjs', '--parent', parent, '--check');
await run('scripts/generate-python-fixtures.mjs', '--parent', parent, '--check');
await run('scripts/generate-test-crosswalk.mjs', '--parent', parent, '--check');
await run('scripts/generate-typescript-fixtures.mjs', '--check');
await run('scripts/validate-typescript-fixtures.mjs', '--parent', parent);
console.log('Bidirectional Python parity suite passed.');

function run(script, ...args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [resolve(repoRoot, script), ...args], {
      cwd: repoRoot,
      env: process.env,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${script} failed with ${signal ?? `exit code ${code}`}.`));
    });
  });
}

function requiredArgument(name) {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} <path> is required.`);
  return value;
}
