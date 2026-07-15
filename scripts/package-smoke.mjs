import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const directory = await mkdtemp(join(tmpdir(), 'blackbox-ts-package-'));
const cache = join(directory, '.npm-cache');
const npm =
  process.platform === 'win32'
    ? {
        executable: process.execPath,
        prefix: [join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')],
      }
    : { executable: 'npm', prefix: [] };

try {
  const packed = await execFileAsync(
    npm.executable,
    [
      ...npm.prefix,
      'pack',
      '--json',
      '--pack-destination',
      directory,
      '--ignore-scripts',
      '--cache',
      cache,
    ],
    { cwd: root, windowsHide: true, maxBuffer: 10 * 1024 * 1024 },
  );
  const report = JSON.parse(packed.stdout);
  const packageReport = report[0];
  if (packageReport === undefined) throw new Error('npm pack produced no report');
  const files = new Set(packageReport.files.map((entry) => entry.path));
  for (const required of [
    'dist/index.js',
    'dist/index.d.ts',
    'docs/PARITY_MATRIX.md',
    'examples/model-turn.ts',
  ]) {
    if (!files.has(required)) throw new Error(`packed package is missing ${required}`);
  }
  if ([...files].some((path) => path.startsWith('src/'))) {
    throw new Error('packed package unexpectedly contains TypeScript source');
  }

  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify({ private: true, type: 'module' }),
    'utf8',
  );
  await execFileAsync(
    npm.executable,
    [
      ...npm.prefix,
      'install',
      join(directory, packageReport.filename),
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--cache',
      cache,
    ],
    { cwd: directory, windowsHide: true, maxBuffer: 10 * 1024 * 1024 },
  );
  const installedPackage = JSON.parse(
    await readFile(join(directory, 'node_modules', 'blackbox-ts', 'package.json'), 'utf8'),
  );
  if (installedPackage.name !== 'blackbox-ts') throw new Error('clean consumer install failed');

  await writeFile(
    join(directory, 'smoke.mjs'),
    `import { EchoModelProvider, ProviderRegistry } from 'blackbox-ts';
import { MCPServer } from 'blackbox-ts/mcp';
import { InMemoryWorkSource } from 'blackbox-ts/workers';
const registry = new ProviderRegistry();
registry.registerModelProvider(new EchoModelProvider());
if (!(new MCPServer('smoke')) || !(new InMemoryWorkSource())) throw new Error('subpath smoke failed');
console.log('clean package consumer smoke passed');
`,
    'utf8',
  );
  await execFileAsync(process.execPath, [join(directory, 'smoke.mjs')], {
    cwd: directory,
    windowsHide: true,
  });
  console.log(`Package smoke OK: ${files.size} files, clean install, root and subpath imports.`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
