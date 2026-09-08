import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  AgentRuntimeError,
  InMemoryWorkspaceAgentRegistry,
  importPythonWorkspaceAgentPackage,
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

import pythonPackage from '../fixtures/python/workspace-agent-package.json';
import parityInventory from '../../docs/parity-inventory.json';
import { translatePythonPackage } from '../../src/workspace-agents/python-package.js';

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

  it('parses block-list frontmatter and round-trips it through the inline exporter', () => {
    // Hand-written SKILL.md in the parent's fallback grammar ((parent)
    // tests/unit/skills/test_skills.py L16-51): block lists of scalars, a
    // list of maps with continuation lines, a nested block mapping, and a
    // bare `-` item. Only fields `skillToMarkdown` emits are used so the
    // re-parse can be compared for equality.
    const parsed = parseSkillMarkdown(
      [
        '---',
        'name: review-pr',
        'description: "Review pull requests."',
        'version: 0.2.0',
        'tools:',
        '  - get_diff',
        '  - "post_comment"',
        'hosted_tools:',
        '  - type: web_search',
        '',
        'mcp_connections:',
        '  - id: github',
        '    transport: provider_native',
        '    server_label: github',
        '  # a comment between items',
        '  - id: jira',
        '    transport: provider_native',
        '    server_label: jira',
        'workspace:',
        '  kind: local',
        '  read_only: true',
        'output: { "strategy": "posthoc_parse", "schema": { "type": "object" } }',
        'approval_actions:',
        '  -',
        '  - publish',
        '',
        '---',
        '',
        'Check correctness before style.',
      ].join('\r\n'),
    );

    expect(parsed).toEqual({
      name: 'review-pr',
      description: 'Review pull requests.',
      body: 'Check correctness before style.',
      tools: ['get_diff', 'post_comment'],
      hosted_tools: [{ type: 'web_search' }],
      mcp_connections: [
        { id: 'github', transport: 'provider_native', server_label: 'github' },
        { id: 'jira', transport: 'provider_native', server_label: 'jira' },
      ],
      workspace: { kind: 'local', read_only: true },
      output: { strategy: 'posthoc_parse', schema: { type: 'object' } },
      approval_actions: ['publish'],
      metadata: { version: '0.2.0' },
    });
    const exported = skillToMarkdown(parsed);
    expect(exported).not.toContain('\n  - ');
    expect(parseSkillMarkdown(exported)).toEqual(parsed);
  });

  it('keeps the block-list grammar within the parent fallback', () => {
    const parse = (lines: readonly string[]) =>
      parseSkillMarkdown(`---\nname: "grammar"\n${lines.join('\n')}\n---\nBody`).metadata;

    // Bare `-` is an empty (null) item; an indented list under it nests.
    expect(parse(['examples:', '  -', '  - 12', '  - true', '  -', '    - nested'])).toEqual({
      examples: [null, 12, true, ['nested']],
    });
    // A key with nothing after it and no nested block is null, as in the parent.
    expect(parse(['empty:', 'after: 1'])).toEqual({ empty: null, after: 1 });
    // A quoted or inline-JSON item is a scalar even when it contains a colon.
    expect(parse(['items:', '  - "note: quoted"', '  - ["a", "b"]'])).toEqual({
      items: ['note: quoted', ['a', 'b']],
    });
    // The parent's own export of a list-of-maps item carrying nested values:
    // a bare `-` holding a mapping with a nested mapping and a nested list
    // ((parent) tests/unit/skills/test_skills.py L51 as frontmatter.py
    // `_dump_list_item` renders it without PyYAML).
    expect(
      parse([
        'permissions:',
        '  -',
        '    approval:',
        '      mode: always',
        '    ref: post_comment',
        '    scopes:',
        '      - write',
      ]),
    ).toEqual({
      permissions: [{ approval: { mode: 'always' }, ref: 'post_comment', scopes: ['write'] }],
    });
    // A list item before any key, a block list after an inline value, and
    // unexpected indentation all fail closed.
    for (const lines of [
      ['- orphan'],
      ['tools: ["a"]', '  - b'],
      ['tools:', '    - too-deep'],
      ['nested:', '  key: 1', '    deeper: 2'],
    ]) {
      expect(() => parse(lines)).toThrowError(
        expect.objectContaining({ code: 'invalid_skill_frontmatter' }),
      );
    }
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

  it('round-trips allowlist_v1 grants and reports invalid ones fail-closed', () => {
    const inherited = fixtureAgent();
    expect(validateWorkspaceAgent(inherited)).toEqual([]);
    expect(inherited.permission_mode).toBeUndefined();

    const restricted: WorkspaceAgentSpec = {
      ...inherited,
      permission_mode: 'allowlist_v1',
      connectors: [{ name: 'crm', type: 'test', auth: 'api_key', tool_refs: ['search'] }],
      grants: [{ ref: 'search', scopes: ['execute'], connector: 'crm' }],
    };
    expect(validateWorkspaceAgent(restricted)).toEqual([]);
    expect(unpackWorkspaceAgent(packWorkspaceAgent(restricted)).agent).toEqual(restricted);

    expect(
      validateWorkspaceAgent({
        ...restricted,
        grants: [{ ref: 'search' }, { ref: 'local:search' }],
      }),
    ).toEqual([
      {
        path: 'grants',
        code: 'invalid_permission_grants',
        message: 'Duplicate package permission: local:search.',
      },
    ]);
    expect(
      validateWorkspaceAgent({
        ...inherited,
        permission_mode: 'allow' as WorkspaceAgentSpec['permission_mode'],
      }).map((finding) => finding.code),
    ).toEqual(['invalid_permission_mode']);
    expect(() =>
      new InMemoryWorkspaceAgentRegistry().publish({
        ...restricted,
        grants: [{ ref: 'search', connector: 'unknown' }],
      }),
    ).toThrowError(expect.objectContaining({ code: 'invalid_workspace_agent' }));
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

describe('explicit Python workspace-agent ingress', () => {
  const options = { connector_auth: { files: 'host-managed' } };
  function project(patch: Record<string, unknown>) {
    const manifest = {
      ...pythonPackage.manifest,
      spec: { ...pythonPackage.manifest.spec, ...patch },
    };
    return translatePythonPackage(
      new Map([
        ['agent.json', Buffer.from(JSON.stringify(manifest))],
        ['instructions.md', Buffer.from('Read safely.')],
      ]),
      options,
    );
  }

  it('imports a pinned Python-written ZIP explicitly and round-trips the native projection', () => {
    const bytes = Buffer.from(pythonPackage.archive_base64, 'base64');
    expect(pythonPackage.parent_commit).toBe(parityInventory.python_reference.commit);
    expect(() => unpackWorkspaceAgent(bytes)).toThrow();
    const imported = importPythonWorkspaceAgentPackage(bytes, options);
    expect(imported.source).toBe('python');
    expect(imported.spec).toMatchObject({
      version: '1.2.3',
      model: 'script:model',
      instructions: 'Read safely.',
      permissions: {},
      permission_mode: 'allowlist_v1',
      grants: [{ ref: 'workspace:read' }],
      tools: ['workspace_read', 'workspace_list', 'workspace_write', 'workspace_command'],
      connectors: [
        {
          name: 'files',
          type: 'filesystem',
          auth: 'host-managed',
          auth_mode: 'end_user',
          tool_refs: ['workspace:read', 'workspace:list', 'workspace:write', 'workspace:command'],
        },
      ],
    });
    expect(imported.run_options).toEqual({ agent_provider: 'local' });
    expect(unpackWorkspaceAgent(packWorkspaceAgent(imported.spec)).agent).toEqual(imported.spec);
    expect(() => importPythonWorkspaceAgentPackage(bytes)).toThrow(/connector_auth/);
    expect(() => importPythonWorkspaceAgentPackage(bytes.subarray(0, 40), options)).toThrow();
  });

  it('translates operation and local grant refs without changing approval or connector authority', () => {
    const { spec } = project({
      permissions: [
        {
          ref: 'workspace:write_file',
          scopes: ['write'],
          connector: 'files',
          approval: { mode: 'always', reason: 'Review' },
        },
        { ref: 'local:workspace_run_command', scopes: ['execute'] },
      ],
    });
    expect(spec.grants).toMatchObject([
      {
        ref: 'workspace:write',
        scopes: ['write'],
        connector: 'files',
        approval: { mode: 'always', reason: 'Review' },
      },
      { ref: 'local:workspace_command', scopes: ['execute'] },
    ]);
  });

  it('preserves descriptive records and safe publication without inventing execution settings', () => {
    const imported = project({
      metadata: { owner: 'team', labels: ['checked'], metadata: { ticket: 2 } },
      version: {
        version: '2.0.0',
        changelog: 'Reviewed',
        previous_version: '1.2.3',
        metadata: { release: 2 },
      },
      publication: {
        visibility: 'public',
        directory_enabled: false,
        approved: false,
        channels: [],
        metadata: { note: 'descriptive' },
      },
    });
    expect(imported.spec).toMatchObject({
      version: '2.0.0',
      visibility: 'public',
      metadata: {
        python_package: {
          metadata: { owner: 'team', labels: ['checked'], metadata: { ticket: 2 } },
          version: { changelog: 'Reviewed', previous_version: '1.2.3', metadata: { release: 2 } },
          publication: { metadata: { note: 'descriptive' } },
        },
      },
    });
  });

  it('rejects missing, invalid-text and unconsumed archive members with domain errors', () => {
    const files = new Map([
      ['agent.json', Buffer.from(JSON.stringify(pythonPackage.manifest))],
      ['instructions.md', Buffer.from('Read safely.')],
    ]);
    expect(() => translatePythonPackage(new Map(), options)).toThrowError(AgentRuntimeError);
    for (const name of ['agent.json', 'instructions.md']) {
      const invalid = new Map(files);
      invalid.set(name, Buffer.from([0xff]));
      expect(() => translatePythonPackage(invalid, options)).toThrowError(AgentRuntimeError);
    }
    files.set('unconsumed.txt', Buffer.from('must not disappear'));
    expect(() => translatePythonPackage(files, options)).toThrowError(AgentRuntimeError);
  });

  it('keeps custom workspace-prefixed tool names and accepts native model-reference syntax', () => {
    expect(
      project({
        tools: ['workspace_custom'],
        model_provider: null,
        model: 'script/model',
        instructions: 'Read safely.',
      }).spec,
    ).toMatchObject({ tools: ['workspace_custom'], model: 'script:model' });
  });

  it.each([
    { agent_id: 'existing' },
    { agent_provider: 'codex' },
    { model_provider: 'other', model: 'script:model' },
    { permissions: {} },
    { permissions: [{ ref: 'workspace:delete_file' }] },
    { permissions: [{ ref: 'read', connector: 'unknown' }] },
    { grants: [] },
    { skills: [{ name: 'required' }] },
    { schedules: [{ enabled: false }] },
    { mcp_servers: [{ name: 'server' }] },
    { mcp_toolsets: [{}] },
    { memory: { mode: 'session' } },
    { publication: { visibility: 'workspace' } },
    { publication: { directory_enabled: true } },
    { hosted_tools: [{ search_context_size: 'medium' }] },
    { extra: [] },
    { permission_mode: null },
    { instructions: 'Conflict' },
    { tools: ['workspace_delete_file'] },
    { permissions: [{ ref: 'read', approval: null }] },
    { model: 'script:', model_provider: null },
  ])('rejects unrepresentable or malformed foreign authority: %j', (patch) => {
    expect(() => project(patch)).toThrowError(AgentRuntimeError);
  });
});
