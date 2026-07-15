import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  InMemoryWorkspaceAgentRegistry,
  SQLiteWorkspaceAgentRegistry,
  ScheduleExecutor,
  assertValidWorkspaceAgent,
  compileSkill,
  packWorkspaceAgent,
  installWorkspaceAgentPackage,
  parseSchedule,
  parseSkillMarkdown,
  readWorkspaceAgentDirectory,
  skillToMarkdown,
  unpackWorkspaceAgent,
  validateWorkspaceAgent,
  writeWorkspaceAgentDirectory,
  type SkillSpec,
  type SQLiteDatabase,
  type WorkspaceAgentSpec,
} from '../../src/index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function fixtureSkill(): SkillSpec {
  return parseSkillMarkdown(`---
name: "research"
description: "Research a topic"
tools: ["search"]
approval_actions: ["publish"]
---
Use sources and cite them.`);
}

function fixtureAgent(): WorkspaceAgentSpec {
  return {
    id: 'research-agent',
    name: 'Research Agent',
    version: '1.0.0',
    instructions: 'Research carefully.',
    model: 'openai:gpt-5',
    tools: ['search'],
    connectors: [],
    mcp_servers: [],
    permissions: { tools: ['search'], workspace_read: true },
    schedules: [{ id: 'daily', expression: '0 9 * * *', timezone: 'UTC', input: 'daily research' }],
    skills: [fixtureSkill()],
    visibility: 'private',
    metadata: {},
  };
}

describe('skills and workspace agents', () => {
  it('round-trips deterministic skills and compiles progressive disclosure', () => {
    const skill = fixtureSkill();
    expect(parseSkillMarkdown(skillToMarkdown(skill))).toEqual(skill);
    const compiled = compileSkill(
      skill,
      new Map([['search', { name: 'search', handler: () => 'result' }]]),
    );
    expect(compiled.prompt_fragment).toContain('Available skill: research');
    expect(compiled.tools.map((tool) => tool.name)).toEqual(['search']);
    expect(() => parseSkillMarkdown('---\nname: "broken"\nnot-a-field\n---\nBody')).toThrowError(
      expect.objectContaining({ code: 'invalid_skill_frontmatter' }),
    );
  });

  it('round-trips and compiles hosted, MCP, workspace, and output skill requirements', () => {
    const skill: SkillSpec = {
      ...fixtureSkill(),
      hosted_tools: [{ type: 'web_search' }],
      mcp_connections: [{ id: 'github', transport: 'provider_native', server_label: 'github' }],
      workspace: { kind: 'local', read_only: true },
      output: { strategy: 'posthoc_parse', schema: { type: 'object' } },
    };

    const restored = parseSkillMarkdown(skillToMarkdown(skill));
    const compiled = compileSkill(
      restored,
      new Map([['search', { name: 'search', handler: () => 'result' }]]),
    );
    expect(restored).toEqual(skill);
    expect(compiled).toMatchObject({
      hosted_tools: [{ type: 'web_search' }],
      mcp_connections: [{ id: 'github', transport: 'provider_native' }],
      workspace: { kind: 'local', read_only: true },
      output: { strategy: 'posthoc_parse' },
    });
  });

  it('validates references, versions registry records, and round-trips packages', async () => {
    const spec = fixtureAgent();
    assertValidWorkspaceAgent(spec, {
      tools: new Set(['search']),
      models: new Set(['openai:gpt-5']),
    });
    const invalid = { ...spec, tools: ['missing', 'missing'] };
    expect(
      validateWorkspaceAgent(invalid, { tools: new Set(['search']) }).map((item) => item.code),
    ).toEqual(expect.arrayContaining(['duplicate_tool', 'unknown_tool']));

    const registry = new InMemoryWorkspaceAgentRegistry(() => new Date('2026-01-01T00:00:00Z'));
    registry.publish(spec);
    expect(() => registry.publish(spec)).toThrowError(
      expect.objectContaining({ code: 'agent_version_exists' }),
    );
    registry.deprecate(spec.id, spec.version);
    expect(registry.list()).toHaveLength(0);
    expect(registry.list({ include_deprecated: true })).toHaveLength(1);

    const archive = packWorkspaceAgent(spec);
    expect(Buffer.from(archive).subarray(0, 4).toString('hex')).toBe('504b0304');
    expect(unpackWorkspaceAgent(archive).agent).toEqual(spec);
    const directory = await mkdtemp(join(tmpdir(), 'blackbox-agent-'));
    temporaryDirectories.push(directory);
    await writeWorkspaceAgentDirectory(directory, spec);
    const restored = await readWorkspaceAgentDirectory(directory);
    expect(restored.instructions).toBe(spec.instructions);
    expect(restored.skills.map((skill) => skill.name)).toEqual(['research']);
    const installedDirectory = await mkdtemp(join(tmpdir(), 'blackbox-agent-install-'));
    temporaryDirectories.push(installedDirectory);
    await installWorkspaceAgentPackage(installedDirectory, packWorkspaceAgent(spec));
    expect(await readWorkspaceAgentDirectory(installedDirectory)).toMatchObject({ id: spec.id });

    const malicious = Buffer.from(archive);
    replaceAllBytes(malicious, 'agent.json', '../evil.js');
    expect(() => unpackWorkspaceAgent(malicious)).toThrowError(
      expect.objectContaining({ code: 'archive_path_traversal' }),
    );

    expect(() =>
      packWorkspaceAgent({
        ...spec,
        skills: [{ ...fixtureSkill(), name: '../escape' }],
      }),
    ).toThrowError(expect.objectContaining({ code: 'archive_path_traversal' }));

    expect(() =>
      packWorkspaceAgent({
        ...spec,
        skills: [fixtureSkill(), { ...fixtureSkill(), name: 'Research' }],
      }),
    ).toThrowError(expect.objectContaining({ code: 'invalid_workspace_agent' }));

    const futureDirectory = await mkdtemp(join(tmpdir(), 'blackbox-agent-future-'));
    temporaryDirectories.push(futureDirectory);
    await mkdir(join(futureDirectory, 'skills'), { recursive: true });
    await writeFile(
      join(futureDirectory, 'agent.json'),
      JSON.stringify({ format: 'blackbox/workspace-agent', format_version: 2, spec }),
    );
    await writeFile(join(futureDirectory, 'instructions.md'), 'future');
    await expect(readWorkspaceAgentDirectory(futureDirectory)).rejects.toMatchObject({
      code: 'unsupported_agent_package',
    });

    const malformedDirectory = await mkdtemp(join(tmpdir(), 'blackbox-agent-malformed-'));
    temporaryDirectories.push(malformedDirectory);
    await writeFile(
      join(malformedDirectory, 'agent.json'),
      JSON.stringify({
        format: 'blackbox/workspace-agent',
        format_version: 1,
        spec: { ...spec, instructions: undefined, skills: undefined, tools: {} },
      }),
    );
    await expect(readWorkspaceAgentDirectory(malformedDirectory)).rejects.toMatchObject({
      code: 'malformed_agent_package',
    });
  });

  it('reports schedule, permission, and embedded-skill consistency errors together', () => {
    const spec = fixtureAgent();
    const invalid: WorkspaceAgentSpec = {
      ...spec,
      schedules: [spec.schedules[0]!, { ...spec.schedules[0]!, expression: 'bad cron' }],
      permissions: {
        tools: ['missing-tool'],
        connectors: ['missing-connector'],
        mcp_servers: ['missing-mcp'],
      },
      skills: [
        {
          ...fixtureSkill(),
          name: '../not-portable',
          body: '',
          tools: ['missing-tool'],
          mcp_connections: [
            { id: 'missing-mcp', transport: 'provider_native', server_label: 'missing' },
          ],
        },
      ],
    };

    expect(validateWorkspaceAgent(invalid).map((finding) => finding.code)).toEqual(
      expect.arrayContaining([
        'duplicate_schedule',
        'invalid_schedule',
        'permission_mismatch',
        'invalid_skill_name',
        'missing_skill_body',
        'unknown_skill_tool',
        'unknown_skill_mcp',
      ]),
    );
    expect(() => new InMemoryWorkspaceAgentRegistry().publish(invalid)).toThrowError(
      expect.objectContaining({ code: 'invalid_workspace_agent' }),
    );
  });

  it('persists versioned workspace agents in a real SQLite registry', async () => {
    let DatabaseSync: (new (path: string) => SQLiteDatabase & { close(): void }) | undefined;
    try {
      ({ DatabaseSync } = (await import('node:sqlite')) as unknown as {
        DatabaseSync: new (path: string) => SQLiteDatabase & { close(): void };
      });
    } catch {
      return;
    }
    const database = new DatabaseSync(':memory:');
    try {
      const registry = new SQLiteWorkspaceAgentRegistry(
        database,
        () => new Date('2026-01-01T00:00:00Z'),
      );
      const first = fixtureAgent();
      const second = { ...first, version: '2.0.0', visibility: 'public' as const };
      registry.publish(first);
      registry.publish(second);

      expect(registry.get(first.id)?.spec).toEqual(second);
      expect(registry.list({ visibility: 'private' })).toHaveLength(1);
      registry.deprecate(first.id, second.version);
      expect(registry.list()).toEqual([expect.objectContaining({ spec: first })]);
      expect(registry.list({ include_deprecated: true })).toHaveLength(2);
      expect(() => registry.publish(first)).toThrowError(
        expect.objectContaining({ code: 'agent_version_exists' }),
      );
    } finally {
      database.close();
    }
  });

  it('parses timezone-aware cron/interval schedules and collapses missed windows', async () => {
    expect(parseSchedule('*/15 * * * *').next(new Date('2026-01-01T00:01:00Z')).toISOString()).toBe(
      '2026-01-01T00:15:00.000Z',
    );
    expect(parseSchedule('every 2h').next(new Date('2026-01-01T00:00:00Z')).toISOString()).toBe(
      '2026-01-01T02:00:00.000Z',
    );
    expect(() => parseSchedule('0 9 * * *', 'Mars/Olympus_Mons')).toThrowError(
      expect.objectContaining({ code: 'invalid_schedule_timezone' }),
    );
    const executions: string[] = [];
    const executor = new ScheduleExecutor(
      (_schedule, ref) => executions.push(ref.scheduled_for),
      undefined,
      () => new Date('2026-01-01T12:00:00Z'),
    );
    const refs = await executor.runDue(
      [{ id: 'hourly', expression: '0 * * * *', input: 'run' }],
      new Date('2026-01-01T08:30:00Z'),
    );
    expect(refs).toHaveLength(1);
    expect(executions).toEqual(['2026-01-01T12:00:00.000Z']);
  });
});

function replaceAllBytes(buffer: Buffer, from: string, to: string): void {
  const source = Buffer.from(from);
  const replacement = Buffer.from(to);
  expect(replacement).toHaveLength(source.length);
  let cursor = 0;
  let replacements = 0;
  while ((cursor = buffer.indexOf(source, cursor)) !== -1) {
    replacement.copy(buffer, cursor);
    cursor += replacement.length;
    replacements += 1;
  }
  expect(replacements).toBeGreaterThanOrEqual(2);
}
