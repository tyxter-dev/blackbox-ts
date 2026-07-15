import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, sep } from 'node:path';
import { AgentRuntimeError } from '../core/errors.js';
import { parseSkillMarkdown, skillToMarkdown } from '../skills/index.js';
import type { WorkspaceAgentPackage, WorkspaceAgentSpec } from './types.js';

export async function writeWorkspaceAgentDirectory(
  root: string,
  spec: WorkspaceAgentSpec,
): Promise<void> {
  await mkdir(join(root, 'skills'), { recursive: true });
  const jsonSpec = {
    ...spec,
    instructions: undefined,
    skills: undefined,
    metadata: { ...spec.metadata, skill_names: spec.skills.map((skill) => skill.name).sort() },
  };
  await writeFile(join(root, 'agent.json'), `${JSON.stringify(jsonSpec, null, 2)}\n`, 'utf8');
  await writeFile(join(root, 'instructions.md'), `${spec.instructions.trim()}\n`, 'utf8');
  for (const skill of [...spec.skills].sort((left, right) => left.name.localeCompare(right.name))) {
    assertSafeEntry(`skills/${skill.name}/SKILL.md`);
    const path = join(root, 'skills', skill.name, 'SKILL.md');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, skillToMarkdown(skill), 'utf8');
  }
}

export async function readWorkspaceAgentDirectory(root: string): Promise<WorkspaceAgentSpec> {
  const raw = JSON.parse(await readFile(join(root, 'agent.json'), 'utf8')) as Omit<
    WorkspaceAgentSpec,
    'instructions' | 'skills'
  >;
  const instructions = await readFile(join(root, 'instructions.md'), 'utf8');
  const skillNames = Array.isArray(
    (raw.metadata as Record<string, unknown> | undefined)?.skill_names,
  )
    ? ((raw.metadata as Record<string, unknown>).skill_names as unknown[]).filter(
        (name): name is string => typeof name === 'string',
      )
    : [];
  const skills = await Promise.all(
    skillNames.map(async (name) =>
      parseSkillMarkdown(await readFile(join(root, 'skills', name, 'SKILL.md'), 'utf8')),
    ),
  );
  return { ...raw, instructions: instructions.trim(), skills };
}

export function packWorkspaceAgent(spec: WorkspaceAgentSpec): Uint8Array {
  const files: Record<string, string> = {
    'agent.json': Buffer.from(
      JSON.stringify({
        ...spec,
        instructions: undefined,
        skills: undefined,
        metadata: { ...spec.metadata, skill_names: spec.skills.map((skill) => skill.name).sort() },
      }),
    ).toString('base64'),
    'instructions.md': Buffer.from(`${spec.instructions.trim()}\n`).toString('base64'),
  };
  for (const skill of spec.skills) {
    const path = `skills/${skill.name}/SKILL.md`;
    assertSafeEntry(path);
    files[path] = Buffer.from(skillToMarkdown(skill)).toString('base64');
  }
  const bundle: WorkspaceAgentPackage = {
    format_version: 1,
    agent: spec,
    files: Object.fromEntries(
      Object.entries(files).sort(([left], [right]) => left.localeCompare(right)),
    ),
  };
  return Buffer.from(JSON.stringify(bundle));
}

export function unpackWorkspaceAgent(archive: Uint8Array): WorkspaceAgentPackage {
  const bundle = JSON.parse(
    Buffer.from(archive).toString('utf8'),
  ) as Partial<WorkspaceAgentPackage>;
  if (bundle.format_version !== 1 || bundle.agent === undefined || bundle.files === undefined)
    throw new AgentRuntimeError('Unsupported or malformed workspace-agent package.', {
      code: 'unsupported_agent_package',
    });
  for (const path of Object.keys(bundle.files)) assertSafeEntry(path);
  return bundle as WorkspaceAgentPackage;
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
  return bundle.agent;
}

function assertSafeEntry(path: string): void {
  const normalized = normalize(path);
  if (path.includes('..') || normalized.startsWith(sep) || /^[a-z]:/i.test(normalized))
    throw new AgentRuntimeError(`Unsafe package entry '${path}'.`, {
      code: 'archive_path_traversal',
    });
}
