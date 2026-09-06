import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentRuntimeError } from '../core/errors.js';
import type { OutputSpec } from '../core/results.js';
import type { HostedToolSpec, MCPConnectionSpec } from '../providers/base.js';
import type { ToolDefinition } from '../tools/types.js';

export interface SkillSpec {
  readonly name: string;
  readonly description?: string;
  readonly body: string;
  readonly tools: readonly string[];
  readonly hosted_tools: readonly HostedToolSpec[];
  readonly mcp_connections: readonly MCPConnectionSpec[];
  readonly workspace?: Readonly<Record<string, unknown>>;
  readonly output?: OutputSpec;
  readonly approval_actions: readonly string[];
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface CompiledSkill {
  readonly prompt_fragment: string;
  readonly tools: readonly ToolDefinition[];
  readonly hosted_tools: readonly HostedToolSpec[];
  readonly mcp_connections: readonly MCPConnectionSpec[];
  readonly workspace?: Readonly<Record<string, unknown>>;
  readonly output?: OutputSpec;
  readonly approval_actions: readonly string[];
}

export function parseSkillMarkdown(markdown: string): SkillSpec {
  const normalized = markdown.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  if (!normalized.startsWith('---\n')) {
    throw new AgentRuntimeError('Skill Markdown must start with frontmatter.', {
      code: 'invalid_skill_frontmatter',
    });
  }
  const end = normalized.indexOf('\n---\n', 4);
  if (end < 0) {
    throw new AgentRuntimeError('Skill Markdown frontmatter is not terminated.', {
      code: 'invalid_skill_frontmatter',
    });
  }
  const frontmatter = parseFrontmatter(normalized.slice(4, end));
  if (typeof frontmatter.name !== 'string' || !frontmatter.name.trim()) {
    throw new AgentRuntimeError('Skill frontmatter requires a name.', { code: 'invalid_skill' });
  }
  return {
    name: frontmatter.name,
    description: typeof frontmatter.description === 'string' ? frontmatter.description : undefined,
    body: normalized.slice(end + 5).trim(),
    tools: readStrings(frontmatter.tools),
    hosted_tools: readRecords<HostedToolSpec>(frontmatter.hosted_tools),
    mcp_connections: readRecords<MCPConnectionSpec>(frontmatter.mcp_connections),
    workspace: readRecord(frontmatter.workspace),
    output: readRecord(frontmatter.output) as OutputSpec | undefined,
    approval_actions: readStrings(frontmatter.approval_actions),
    metadata: Object.fromEntries(
      Object.entries(frontmatter).filter(
        ([key]) =>
          ![
            'name',
            'description',
            'tools',
            'hosted_tools',
            'mcp_connections',
            'workspace',
            'output',
            'approval_actions',
          ].includes(key),
      ),
    ),
  };
}

export function skillToMarkdown(skill: SkillSpec): string {
  const lines = ['---', `name: ${quoteScalar(skill.name)}`];
  if (skill.description !== undefined) lines.push(`description: ${quoteScalar(skill.description)}`);
  if (skill.tools.length > 0) lines.push(`tools: [${skill.tools.map(quoteScalar).join(', ')}]`);
  if (skill.hosted_tools.length > 0) {
    lines.push(`hosted_tools: ${JSON.stringify(skill.hosted_tools)}`);
  }
  if (skill.mcp_connections.length > 0) {
    lines.push(`mcp_connections: ${JSON.stringify(skill.mcp_connections)}`);
  }
  if (skill.workspace !== undefined) lines.push(`workspace: ${JSON.stringify(skill.workspace)}`);
  if (skill.output !== undefined) lines.push(`output: ${JSON.stringify(skill.output)}`);
  if (skill.approval_actions.length > 0) {
    lines.push(`approval_actions: [${skill.approval_actions.map(quoteScalar).join(', ')}]`);
  }
  for (const [key, value] of Object.entries(skill.metadata).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (typeof value === 'string') lines.push(`${key}: ${quoteScalar(value)}`);
    else if (typeof value === 'number' || typeof value === 'boolean')
      lines.push(`${key}: ${String(value)}`);
  }
  return `${lines.join('\n')}\n---\n\n${skill.body.trim()}\n`;
}

export function compileSkill(
  skill: SkillSpec,
  tools: ReadonlyMap<string, ToolDefinition> = new Map(),
): CompiledSkill {
  const definitions = skill.tools.map((name) => {
    const tool = tools.get(name);
    if (tool === undefined) {
      throw new AgentRuntimeError(`Skill '${skill.name}' references unknown tool '${name}'.`, {
        code: 'skill_tool_not_found',
      });
    }
    return tool;
  });
  return {
    prompt_fragment: [
      `Available skill: ${skill.name}${skill.description === undefined ? '' : ` — ${skill.description}`}.`,
      `Load the following instructions when the skill is relevant:\n${skill.body}`,
    ].join('\n'),
    tools: definitions,
    hosted_tools: skill.hosted_tools,
    mcp_connections: skill.mcp_connections,
    workspace: skill.workspace,
    output: skill.output,
    approval_actions: skill.approval_actions,
  };
}

export async function stageClaudeCodeSkills(
  root: string,
  skills: readonly SkillSpec[],
): Promise<void> {
  const directory = join(root, '.claude', 'skills');
  await mkdir(directory, { recursive: true });
  for (const skill of [...skills].sort((left, right) => left.name.localeCompare(right.name))) {
    validatePortableName(skill.name);
    const skillDirectory = join(directory, skill.name);
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(join(skillDirectory, 'SKILL.md'), skillToMarkdown(skill), 'utf8');
  }
  await mkdir(join(root, '.claude'), { recursive: true });
  await writeFile(
    join(root, '.claude', 'settings.json'),
    `${JSON.stringify({ skills: skills.map((skill) => skill.name).sort() }, null, 2)}\n`,
    'utf8',
  );
}

/**
 * The parent's YAML-subset fallback ((parent) src/blackbox/skills/frontmatter.py
 * L63-158, `_load_simple_yaml`): a top-level mapping whose values are inline
 * scalars, or -- when nothing follows the colon -- an indented block that is
 * either a nested mapping or a list. List items are `-` / `- ...` lines
 * (`_is_list_item`, L322-323): a bare `-` holds a nested block (or `null`
 * when nothing follows), `- key: value` opens a map whose further keys are
 * the continuation lines indented two deeper, and anything else is a scalar.
 * Like the parent, a map item's values are inline scalars only, indentation
 * steps by exactly two spaces, and a list item before any key or a block
 * under a key that already had an inline value fails closed.
 */
function parseFrontmatter(value: string): Record<string, unknown> {
  const lines = value.split('\n').map((line) => line.trimEnd());
  const [result, end] = parseMapping(lines, 0, 0);
  for (let index = end; index < lines.length; index += 1) {
    if (!isBlankOrComment(lines[index] ?? '')) throw malformedLine(lines[index] ?? '');
  }
  return result;
}

function parseMapping(
  lines: readonly string[],
  start: number,
  indent: number,
): [Record<string, unknown>, number] {
  const result: Record<string, unknown> = {};
  let index = start;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (isBlankOrComment(line)) {
      index += 1;
      continue;
    }
    const current = indentOf(line);
    if (current < indent) break;
    if (current > indent) {
      throw new AgentRuntimeError(`Unexpected indentation in skill frontmatter line '${line}'.`, {
        code: 'invalid_skill_frontmatter',
      });
    }
    const stripped = line.trim();
    if (isListItem(stripped)) break;
    const separator = stripped.indexOf(':');
    if (separator < 1) throw malformedLine(line);
    const key = stripped.slice(0, separator).trim();
    const raw = stripped.slice(separator + 1).trim();
    if (raw) {
      result[key] = parseScalar(raw);
      index += 1;
      continue;
    }
    const [nested, next] = parseNested(lines, index + 1, indent + 2);
    result[key] = nested;
    index = next;
  }
  return [result, index];
}

function parseNested(lines: readonly string[], start: number, indent: number): [unknown, number] {
  let index = start;
  while (index < lines.length && isBlankOrComment(lines[index] ?? '')) index += 1;
  if (index >= lines.length || indentOf(lines[index] ?? '') < indent) return [null, index];
  return isListItem((lines[index] ?? '').trim())
    ? parseList(lines, index, indent)
    : parseMapping(lines, index, indent);
}

function parseList(lines: readonly string[], start: number, indent: number): [unknown[], number] {
  const values: unknown[] = [];
  let index = start;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (isBlankOrComment(line)) {
      index += 1;
      continue;
    }
    const current = indentOf(line);
    if (current < indent) break;
    const stripped = line.trim();
    if (current !== indent || !isListItem(stripped)) break;
    const itemText = stripped.slice(2).trim();
    index += 1;
    if (!itemText) {
      const [nested, next] = parseNested(lines, index, indent + 2);
      values.push(nested);
      index = next;
      continue;
    }
    if (looksLikeMappingItem(itemText)) {
      const separator = itemText.indexOf(':');
      const item: Record<string, unknown> = {
        [itemText.slice(0, separator).trim()]: parseScalar(itemText.slice(separator + 1).trim()),
      };
      while (index < lines.length) {
        const child = lines[index] ?? '';
        if (isBlankOrComment(child)) {
          index += 1;
          continue;
        }
        const childIndent = indentOf(child);
        const childText = child.trim();
        if (childIndent < indent + 2) break;
        if (childIndent !== indent + 2 || isListItem(childText)) break;
        const childSeparator = childText.indexOf(':');
        if (childSeparator < 0) throw malformedLine(child);
        item[childText.slice(0, childSeparator).trim()] = parseScalar(
          childText.slice(childSeparator + 1).trim(),
        );
        index += 1;
      }
      values.push(item);
      continue;
    }
    values.push(parseScalar(itemText));
  }
  return [values, index];
}

function isListItem(text: string): boolean {
  return text === '-' || text.startsWith('- ');
}

/** `- key: value` opens a map item unless the key is quoted or inline JSON. */
function looksLikeMappingItem(text: string): boolean {
  const separator = text.indexOf(':');
  if (separator < 0) return false;
  const key = text.slice(0, separator).trim();
  return key.length > 0 && !/^["'[{]/.test(key);
}

function isBlankOrComment(line: string): boolean {
  return !line.trim() || line.trimStart().startsWith('#');
}

function indentOf(line: string): number {
  return line.length - line.replace(/^ +/, '').length;
}

function malformedLine(line: string): AgentRuntimeError {
  return new AgentRuntimeError(`Malformed skill frontmatter line '${line}'.`, {
    code: 'invalid_skill_frontmatter',
  });
}

function parseScalar(value: string): unknown {
  if (
    (value.startsWith('[') && value.endsWith(']')) ||
    (value.startsWith('{') && value.endsWith('}'))
  ) {
    try {
      return JSON.parse(value) as unknown;
    } catch (cause) {
      throw new AgentRuntimeError(`Invalid JSON frontmatter value '${value}'.`, {
        code: 'invalid_skill_frontmatter',
        cause,
      });
    }
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return unquote(value);
}

function readStrings(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function readRecords<T>(value: unknown): readonly T[] {
  return Array.isArray(value)
    ? (value.filter(
        (item) => typeof item === 'object' && item !== null && !Array.isArray(item),
      ) as T[])
    : [];
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function quoteScalar(value: string): string {
  return JSON.stringify(value);
}

function unquote(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  return value;
}

function validatePortableName(value: string): void {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(value) || value.includes('..')) {
    throw new AgentRuntimeError(`Skill name '${value}' is not portable.`, {
      code: 'invalid_skill_name',
    });
  }
}
