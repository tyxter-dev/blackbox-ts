import { inflateRawSync } from 'node:zlib';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, sep } from 'node:path';
import { AgentRuntimeError } from '../core/errors.js';
import { parseSkillMarkdown, skillToMarkdown } from '../skills/index.js';
import type { WorkspaceAgentPackage, WorkspaceAgentSpec } from './types.js';
import { assertValidWorkspaceAgent } from './validation.js';

export const WORKSPACE_AGENT_PACKAGE_FORMAT = 'blackbox/workspace-agent';
export const WORKSPACE_AGENT_PACKAGE_VERSION = 1;

interface WorkspaceAgentManifest {
  readonly format: typeof WORKSPACE_AGENT_PACKAGE_FORMAT;
  readonly format_version: typeof WORKSPACE_AGENT_PACKAGE_VERSION;
  readonly spec: Omit<WorkspaceAgentSpec, 'instructions' | 'skills'>;
}

interface ZipEntry {
  readonly name: string;
  readonly data: Uint8Array;
}

export async function writeWorkspaceAgentDirectory(
  root: string,
  spec: WorkspaceAgentSpec,
): Promise<void> {
  const files = packageFiles(spec);
  for (const [path, content] of files) {
    assertSafeEntry(path);
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

export async function readWorkspaceAgentDirectory(root: string): Promise<WorkspaceAgentSpec> {
  const manifest = parseManifest(await readFile(join(root, 'agent.json'), 'utf8'));
  const instructions = await readFile(join(root, 'instructions.md'), 'utf8');
  const skillNames = readSkillNames(manifest.spec.metadata);
  const skills = await Promise.all(
    skillNames.map(async (name) => {
      assertSafeEntry(`skills/${name}/SKILL.md`);
      return parseSkillMarkdown(await readFile(join(root, 'skills', name, 'SKILL.md'), 'utf8'));
    }),
  );
  const agent = {
    ...manifest.spec,
    instructions: instructions.trim(),
    skills,
    metadata: stripPackageMetadata(manifest.spec.metadata),
  };
  assertValidWorkspaceAgent(agent);
  return agent;
}

/** Build a deterministic, dependency-free ZIP archive using the STORE method. */
export function packWorkspaceAgent(spec: WorkspaceAgentSpec): Uint8Array {
  return encodeZip(packageFiles(spec).map(([name, data]) => ({ name, data })));
}

/** Parse and validate a workspace-agent ZIP without writing any archive member to disk. */
export function unpackWorkspaceAgent(archive: Uint8Array): WorkspaceAgentPackage {
  const entries = decodeZip(archive);
  const files = new Map(entries.map((entry) => [entry.name, entry.data]));
  const manifestBytes = files.get('agent.json');
  const instructionsBytes = files.get('instructions.md');
  if (manifestBytes === undefined || instructionsBytes === undefined) throw malformedPackage();
  const manifest = parseManifest(Buffer.from(manifestBytes).toString('utf8'));
  const skillNames = readSkillNames(manifest.spec.metadata);
  const skills = skillNames.map((name) => {
    const path = `skills/${name}/SKILL.md`;
    assertSafeEntry(path);
    const source = files.get(path);
    if (source === undefined) {
      throw new AgentRuntimeError(`Workspace-agent package is missing '${path}'.`, {
        code: 'malformed_agent_package',
      });
    }
    return parseSkillMarkdown(Buffer.from(source).toString('utf8'));
  });
  const agent: WorkspaceAgentSpec = {
    ...manifest.spec,
    instructions: Buffer.from(instructionsBytes).toString('utf8').trim(),
    skills,
    metadata: stripPackageMetadata(manifest.spec.metadata),
  };
  assertValidWorkspaceAgent(agent);
  return {
    format_version: WORKSPACE_AGENT_PACKAGE_VERSION,
    agent,
    files: Object.fromEntries(
      entries.map((entry) => [entry.name, Buffer.from(entry.data).toString('base64')]),
    ),
  };
}

export async function installWorkspaceAgentPackage(
  root: string,
  archive: Uint8Array,
): Promise<WorkspaceAgentSpec> {
  const bundle = unpackWorkspaceAgent(archive);
  for (const [path, content] of Object.entries(bundle.files)) {
    assertSafeEntry(path);
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(content, 'base64'));
  }
  return readWorkspaceAgentDirectory(root);
}

function packageFiles(spec: WorkspaceAgentSpec): readonly (readonly [string, Uint8Array])[] {
  const skillNames = spec.skills.map((skill) => skill.name).sort();
  for (const name of skillNames) assertSafeEntry(`skills/${name}/SKILL.md`);
  assertValidWorkspaceAgent(spec);
  const portableSpec = { ...spec } as {
    -readonly [Key in keyof WorkspaceAgentSpec]?: WorkspaceAgentSpec[Key];
  } & Record<string, unknown>;
  delete portableSpec.instructions;
  delete portableSpec.skills;
  const manifest: WorkspaceAgentManifest = {
    format: WORKSPACE_AGENT_PACKAGE_FORMAT,
    format_version: WORKSPACE_AGENT_PACKAGE_VERSION,
    spec: {
      ...(portableSpec as Omit<WorkspaceAgentSpec, 'instructions' | 'skills'>),
      metadata: { ...spec.metadata, skill_names: skillNames },
    },
  };
  return [
    ['agent.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)],
    ['instructions.md', Buffer.from(`${spec.instructions.trim()}\n`)],
    ...[...spec.skills]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(
        (skill) => [`skills/${skill.name}/SKILL.md`, Buffer.from(skillToMarkdown(skill))] as const,
      ),
  ];
}

function parseManifest(source: string): WorkspaceAgentManifest {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (cause) {
    throw new AgentRuntimeError('Workspace-agent manifest is not valid JSON.', {
      code: 'malformed_agent_package',
      cause,
    });
  }
  if (!isRecord(value)) throw malformedPackage();
  if (value.format !== WORKSPACE_AGENT_PACKAGE_FORMAT) {
    throw new AgentRuntimeError(
      `Unsupported workspace-agent package format '${String(value.format)}'.`,
      {
        code: 'unsupported_agent_package',
      },
    );
  }
  if (
    typeof value.format_version !== 'number' ||
    !Number.isInteger(value.format_version) ||
    value.format_version > WORKSPACE_AGENT_PACKAGE_VERSION ||
    value.format_version < 1
  ) {
    throw new AgentRuntimeError(
      `Workspace-agent package version '${String(value.format_version)}' is unsupported.`,
      { code: 'unsupported_agent_package' },
    );
  }
  if (!isRecord(value.spec)) throw malformedPackage();
  if (!isPortableManifestSpec(value.spec)) throw malformedPackage();
  return value as unknown as WorkspaceAgentManifest;
}

function readSkillNames(
  metadata: Readonly<Record<string, unknown>> | undefined,
): readonly string[] {
  const names = metadata?.skill_names;
  if (!Array.isArray(names) || names.some((name) => typeof name !== 'string')) return [];
  const result = names as string[];
  for (const name of result) assertSafeEntry(`skills/${name}/SKILL.md`);
  return result;
}

function stripPackageMetadata(
  metadata: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> {
  const value = { ...(metadata ?? {}) };
  delete value.skill_names;
  return value;
}

function encodeZip(entries: readonly ZipEntry[]): Uint8Array {
  if (entries.length > 1_024) {
    throw new AgentRuntimeError('Workspace-agent package contains too many entries.', {
      code: 'agent_package_too_large',
    });
  }
  let aggregateSize = 0;
  for (const entry of entries) {
    if (entry.data.byteLength > 32 * 1024 * 1024) {
      throw new AgentRuntimeError(`Archive entry '${entry.name}' exceeds the package size limit.`, {
        code: 'agent_package_too_large',
      });
    }
    aggregateSize += entry.data.byteLength;
  }
  if (aggregateSize > 64 * 1024 * 1024) {
    throw new AgentRuntimeError('Workspace-agent package exceeds the aggregate size limit.', {
      code: 'agent_package_too_large',
    });
  }
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    assertSafeEntry(entry.name);
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.data);
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function decodeZip(input: Uint8Array): readonly ZipEntry[] {
  const archive = Buffer.from(input);
  const endOffset = findEndOfCentralDirectory(archive);
  const commentLength = archive.readUInt16LE(endOffset + 20);
  if (endOffset + 22 + commentLength !== archive.length) throw malformedPackage();
  if (archive.readUInt16LE(endOffset + 4) !== 0 || archive.readUInt16LE(endOffset + 6) !== 0) {
    throw new AgentRuntimeError('Multi-disk ZIP archives are unsupported.', {
      code: 'unsupported_agent_package',
    });
  }
  if (archive.readUInt16LE(endOffset + 8) !== archive.readUInt16LE(endOffset + 10)) {
    throw malformedPackage();
  }
  const entryCount = archive.readUInt16LE(endOffset + 10);
  if (entryCount > 1_024) {
    throw new AgentRuntimeError('Workspace-agent package contains too many entries.', {
      code: 'agent_package_too_large',
    });
  }
  const centralSize = archive.readUInt32LE(endOffset + 12);
  const centralOffset = archive.readUInt32LE(endOffset + 16);
  assertRange(archive, centralOffset, centralSize);
  if (centralOffset + centralSize !== endOffset) throw malformedPackage();
  const entries: ZipEntry[] = [];
  const seen = new Set<string>();
  let totalUncompressedSize = 0;
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    assertRange(archive, cursor, 46);
    if (archive.readUInt32LE(cursor) !== 0x02014b50) throw malformedPackage();
    const flags = archive.readUInt16LE(cursor + 8);
    const method = archive.readUInt16LE(cursor + 10);
    const checksum = archive.readUInt32LE(cursor + 16);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42);
    assertRange(archive, cursor + 46, nameLength + extraLength + commentLength);
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    assertSafeEntry(name);
    const caseKey = name.toLowerCase();
    if (seen.has(caseKey)) {
      throw new AgentRuntimeError(`Duplicate archive entry '${name}'.`, {
        code: 'malformed_agent_package',
      });
    }
    seen.add(caseKey);
    if ((flags & 1) !== 0 || (method !== 0 && method !== 8)) {
      throw new AgentRuntimeError(`Unsupported ZIP encoding for '${name}'.`, {
        code: 'unsupported_agent_package',
      });
    }
    if (uncompressedSize > 32 * 1024 * 1024) {
      throw new AgentRuntimeError(`Archive entry '${name}' exceeds the package size limit.`, {
        code: 'agent_package_too_large',
      });
    }
    totalUncompressedSize += uncompressedSize;
    if (totalUncompressedSize > 64 * 1024 * 1024) {
      throw new AgentRuntimeError('Workspace-agent package exceeds the aggregate size limit.', {
        code: 'agent_package_too_large',
      });
    }
    assertRange(archive, localOffset, 30);
    if (archive.readUInt32LE(localOffset) !== 0x04034b50) throw malformedPackage();
    const localFlags = archive.readUInt16LE(localOffset + 6);
    const localMethod = archive.readUInt16LE(localOffset + 8);
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    assertRange(archive, localOffset + 30, localNameLength + localExtraLength);
    const localName = archive
      .subarray(localOffset + 30, localOffset + 30 + localNameLength)
      .toString('utf8');
    if (localName !== name || localFlags !== flags || localMethod !== method) {
      throw malformedPackage();
    }
    if (
      (flags & 0x08) === 0 &&
      (archive.readUInt32LE(localOffset + 14) !== checksum ||
        archive.readUInt32LE(localOffset + 18) !== compressedSize ||
        archive.readUInt32LE(localOffset + 22) !== uncompressedSize)
    ) {
      throw malformedPackage();
    }
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    assertRange(archive, dataOffset, compressedSize);
    const compressed = archive.subarray(dataOffset, dataOffset + compressedSize);
    let data: Buffer;
    try {
      data =
        method === 0
          ? Buffer.from(compressed)
          : inflateRawSync(compressed, { maxOutputLength: 32 * 1024 * 1024 + 1 });
    } catch (cause) {
      throw new AgentRuntimeError(`Archive entry '${name}' could not be decompressed safely.`, {
        code: 'agent_package_too_large',
        cause,
      });
    }
    if (data.length !== uncompressedSize || crc32(data) !== checksum) {
      throw new AgentRuntimeError(`Archive entry '${name}' failed integrity validation.`, {
        code: 'malformed_agent_package',
      });
    }
    entries.push({ name, data });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (cursor !== centralOffset + centralSize) throw malformedPackage();
  return entries;
}

function findEndOfCentralDirectory(archive: Buffer): number {
  const minimum = Math.max(0, archive.length - 65_557);
  for (let cursor = archive.length - 22; cursor >= minimum; cursor -= 1) {
    if (archive.readUInt32LE(cursor) === 0x06054b50) return cursor;
  }
  throw malformedPackage();
}

function assertRange(buffer: Buffer, offset: number, length: number): void {
  if (offset < 0 || length < 0 || offset + length > buffer.length) throw malformedPackage();
}

function assertSafeEntry(path: string): void {
  const normalizedSlashes = path.replaceAll('\\', '/');
  const normalized = normalize(path);
  const parts = normalizedSlashes.split('/');
  if (
    path.length === 0 ||
    path.includes('\0') ||
    parts.includes('..') ||
    parts.includes('.') ||
    normalized.startsWith(sep) ||
    normalizedSlashes.startsWith('/') ||
    /^[a-z]:/i.test(normalized)
  ) {
    throw new AgentRuntimeError(`Unsafe package entry '${path}'.`, {
      code: 'archive_path_traversal',
    });
  }
}

function malformedPackage(): AgentRuntimeError {
  return new AgentRuntimeError('Unsupported or malformed workspace-agent package.', {
    code: 'malformed_agent_package',
  });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPortableManifestSpec(value: Readonly<Record<string, unknown>>): boolean {
  return (
    hasStrings(value, ['id', 'name', 'version', 'model']) &&
    isStringArray(value.tools) &&
    isStringArray(value.mcp_servers) &&
    Array.isArray(value.connectors) &&
    value.connectors.every(
      (connector) => isRecord(connector) && hasStrings(connector, ['name', 'type', 'auth']),
    ) &&
    isRecord(value.permissions) &&
    Array.isArray(value.schedules) &&
    value.schedules.every(
      (schedule) => isRecord(schedule) && hasStrings(schedule, ['id', 'expression', 'input']),
    ) &&
    (value.visibility === 'private' ||
      value.visibility === 'internal' ||
      value.visibility === 'public') &&
    isRecord(value.metadata)
  );
}

function hasStrings(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  return keys.every((key) => typeof value[key] === 'string');
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(value: Uint8Array): number {
  let checksum = 0xffffffff;
  for (const byte of value) checksum = CRC_TABLE[(checksum ^ byte) & 0xff]! ^ (checksum >>> 8);
  return (checksum ^ 0xffffffff) >>> 0;
}
