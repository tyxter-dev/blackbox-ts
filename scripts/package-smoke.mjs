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

// npm 10 and 11 report `npm pack --json` as an array of package entries; npm 12 reports an
// object keyed by package name. Either payload can be preceded by banner lines on stdout.
function parsePackReport(stdout) {
  const candidates = [stdout];
  const payloadStart = Math.max(stdout.lastIndexOf('\n['), stdout.lastIndexOf('\n{'));
  if (payloadStart !== -1) candidates.push(stdout.slice(payloadStart + 1));
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Fall through to the banner-trimmed candidate.
    }
  }
  throw new Error('npm pack did not emit a JSON report');
}

function selectPackageReport(report, packageName) {
  if (Array.isArray(report)) {
    if (report.length === 0) throw new Error('npm pack produced no report');
    return report[0];
  }
  if (report === null || typeof report !== 'object') {
    throw new Error('npm pack produced no report');
  }
  const entries = Object.entries(report).filter(
    ([, entry]) => entry !== null && typeof entry === 'object',
  );
  const matched =
    entries.find(([, entry]) => entry.name === packageName) ??
    entries.find(([key]) => key === packageName) ??
    (entries.length === 1 ? entries[0] : undefined);
  if (matched === undefined) {
    throw new Error(`npm pack produced no report for ${packageName}`);
  }
  return matched[1];
}

// Captured report shapes, so the npm versions this host does not run stay covered.
function verifyPackReportParsing() {
  const entry = {
    name: 'blackbox-ts',
    filename: 'blackbox-ts-0.0.0.tgz',
    files: [{ path: 'dist/index.js' }],
  };
  const banner = 'npm notice Tarball Contents';
  for (const [label, stdout] of [
    ['npm 10/11 array', JSON.stringify([entry], null, 2)],
    ['npm 10/11 array behind a banner', `${banner}\n${JSON.stringify([entry], null, 2)}`],
    [
      'npm 12 object behind a banner',
      `${banner}\n${JSON.stringify({ [entry.name]: entry }, null, 2)}`,
    ],
  ]) {
    const selected = selectPackageReport(parsePackReport(stdout.trim()), entry.name);
    if (selected?.filename !== entry.filename) {
      throw new Error(`pack report parser failed for ${label}`);
    }
  }
  for (const [label, run] of [
    ['an empty report object', () => selectPackageReport({}, entry.name)],
    ['an empty report array', () => selectPackageReport([], entry.name)],
    [
      'a report naming other packages only',
      () => selectPackageReport({ a: {}, b: {} }, entry.name),
    ],
    ['non-JSON stdout', () => parsePackReport('npm error code ENOENT')],
  ]) {
    let rejected = false;
    try {
      run();
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error(`pack report parser accepted ${label}`);
  }
}

try {
  verifyPackReportParsing();
  const { name: packageName } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
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
  const packageReport = selectPackageReport(parsePackReport(packed.stdout.trim()), packageName);
  if (!Array.isArray(packageReport.files)) throw new Error('npm pack report lists no files');
  const files = new Set(packageReport.files.map((entry) => entry.path));
  const tracked = new Set(
    (await execFileAsync('git', ['ls-files', '-z'], { cwd: root, windowsHide: true })).stdout
      .split('\0')
      .filter(Boolean),
  );
  const expected = new Set(['package.json', 'README.md', 'CHANGELOG.md', 'FEATURES.md', 'LICENSE']);
  for (const path of tracked) {
    if (path.startsWith('src/') && path.endsWith('.ts')) {
      // A deleted source must not authorize a stale generated module.
      await readFile(join(root, path));
      const stem = `dist/${path.slice(4, -3)}`;
      expected.add(`${stem}.js`);
      expected.add(`${stem}.d.ts`);
    } else if (/^examples\/[^/]+\.ts$/.test(path)) {
      expected.add(path);
    }
  }
  assertTarballShape(files, expected);
  // Exercise the leak guard independently of what this checkout happens to pack.
  for (const rogue of [
    'docs/local.md',
    'dist/index.js.map',
    'dist/untracked.js',
    'examples/untracked.ts',
  ]) {
    let rejected = false;
    try {
      assertTarballShape(new Set([...files, rogue]), expected);
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error(`tarball guard accepted ${rogue}`);
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
    `import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AgentRuntime, EchoModelProvider, ProviderRegistry } from 'blackbox-ts';
import { MCPServer } from 'blackbox-ts/mcp';
import { InMemoryWorkSource } from 'blackbox-ts/workers';
const registry = new ProviderRegistry();
registry.registerModelProvider(new EchoModelProvider());
const runtime = new AgentRuntime({ registry });
const turn = await runtime.models.run({ model: 'echo:echo', input: 'package smoke' });
assert.equal(turn.output_text, 'package smoke');
assert.equal(turn.provider, 'echo');
assert.equal(turn.model, 'echo');
assert.deepEqual(turn.raw_response, { echo: 'package smoke' });
const metadata = JSON.parse(await readFile(new URL(import.meta.resolve('blackbox-ts/package.json')), 'utf8'));
assert.equal(metadata.name, 'blackbox-ts');
assert.equal(metadata.sideEffects, false);
assert.equal(metadata.publishConfig.provenance, true);
if (!(new MCPServer('smoke')) || !(new InMemoryWorkSource())) throw new Error('subpath smoke failed');
console.log('clean package consumer smoke passed');
`,
    'utf8',
  );
  await execFileAsync(process.execPath, [join(directory, 'smoke.mjs')], {
    cwd: directory,
    windowsHide: true,
  });
  console.log(
    `Package smoke OK: ${files.size} files, ${packageReport.unpackedSize} unpacked bytes, clean install, imports and Echo model turn.`,
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}

function assertTarballShape(files, expected) {
  const topLevel = new Set([
    'dist',
    'examples',
    'package.json',
    'README.md',
    'CHANGELOG.md',
    'FEATURES.md',
    'LICENSE',
  ]);
  for (const path of files) {
    if (!topLevel.has(path.split('/')[0]) || path.endsWith('.map') || !expected.has(path)) {
      throw new Error(`packed package contains unexpected or untracked file ${path}`);
    }
  }
  for (const path of expected) {
    if (!files.has(path)) throw new Error(`packed package is missing ${path}`);
  }
}
