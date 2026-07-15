import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  InMemoryWorkspaceAgentRegistry,
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
    registry.deprecate(spec.id, spec.version);
    expect(registry.list()).toHaveLength(0);
    expect(registry.list({ include_deprecated: true })).toHaveLength(1);

    expect(unpackWorkspaceAgent(packWorkspaceAgent(spec)).agent).toEqual(spec);
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

    const malicious = Buffer.from(
      JSON.stringify({ format_version: 1, agent: spec, files: { '../escape': '' } }),
    );
    expect(() => unpackWorkspaceAgent(malicious)).toThrowError(
      expect.objectContaining({ code: 'archive_path_traversal' }),
    );
  });

  it('parses timezone-aware cron/interval schedules and collapses missed windows', async () => {
    expect(parseSchedule('*/15 * * * *').next(new Date('2026-01-01T00:01:00Z')).toISOString()).toBe(
      '2026-01-01T00:15:00.000Z',
    );
    expect(parseSchedule('every 2h').next(new Date('2026-01-01T00:00:00Z')).toISOString()).toBe(
      '2026-01-01T02:00:00.000Z',
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
