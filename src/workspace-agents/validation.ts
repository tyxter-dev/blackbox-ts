import { AgentRuntimeError } from '../core/errors.js';
import { parseSchedule } from '../schedules/index.js';
import type {
  WorkspaceAgentSpec,
  WorkspaceAgentValidationContext,
  WorkspaceAgentValidationIssue,
} from './types.js';

export function validateWorkspaceAgent(
  spec: WorkspaceAgentSpec,
  context: WorkspaceAgentValidationContext = {},
): readonly WorkspaceAgentValidationIssue[] {
  const issues: WorkspaceAgentValidationIssue[] = [];
  if (!spec.id.trim()) issues.push(issue('id', 'Agent id is empty.', 'missing_id'));
  if (!spec.name.trim()) issues.push(issue('name', 'Agent name is empty.', 'missing_name'));
  if (!spec.version.trim())
    issues.push(issue('version', 'Agent version is empty.', 'missing_version'));
  if (!spec.model.trim()) issues.push(issue('model', 'Agent model is empty.', 'missing_model'));
  duplicates(spec.tools).forEach((name) =>
    issues.push(issue('tools', `Duplicate tool '${name}'.`, 'duplicate_tool')),
  );
  duplicates(spec.connectors.map((connector) => connector.name)).forEach((name) =>
    issues.push(issue('connectors', `Duplicate connector '${name}'.`, 'duplicate_connector')),
  );
  duplicates(spec.mcp_servers).forEach((name) =>
    issues.push(issue('mcp_servers', `Duplicate MCP server '${name}'.`, 'duplicate_mcp')),
  );
  duplicates(spec.skills.map((skill) => skill.name.toLowerCase())).forEach((name) =>
    issues.push(
      issue('skills', `Duplicate skill '${name}' (case-insensitive).`, 'duplicate_skill'),
    ),
  );
  duplicates(spec.schedules.map((schedule) => schedule.id)).forEach((id) =>
    issues.push(issue('schedules', `Duplicate schedule '${id}'.`, 'duplicate_schedule')),
  );
  checkKnown(spec.tools, context.tools, 'tools', 'unknown_tool', issues);
  checkKnown(
    spec.connectors.map((connector) => connector.name),
    context.connectors,
    'connectors',
    'unknown_connector',
    issues,
  );
  checkKnown(spec.mcp_servers, context.mcp_servers, 'mcp_servers', 'unknown_mcp', issues);
  if (context.models !== undefined && !context.models.has(spec.model))
    issues.push(issue('model', `Unknown model '${spec.model}'.`, 'unknown_model'));
  for (const name of spec.permissions.tools ?? [])
    if (!spec.tools.includes(name))
      issues.push(
        issue(
          'permissions.tools',
          `Permission references unavailable tool '${name}'.`,
          'permission_mismatch',
        ),
      );
  for (const name of spec.permissions.connectors ?? [])
    if (!spec.connectors.some((connector) => connector.name === name))
      issues.push(
        issue(
          'permissions.connectors',
          `Permission references unavailable connector '${name}'.`,
          'permission_mismatch',
        ),
      );
  for (const name of spec.permissions.mcp_servers ?? [])
    if (!spec.mcp_servers.includes(name))
      issues.push(
        issue(
          'permissions.mcp_servers',
          `Permission references unavailable MCP server '${name}'.`,
          'permission_mismatch',
        ),
      );
  for (const skill of spec.skills) {
    if (!isPortableName(skill.name))
      issues.push(
        issue(
          `skills.${skill.name || '<empty>'}`,
          `Skill name '${skill.name}' is not portable.`,
          'invalid_skill_name',
        ),
      );
    if (!skill.body.trim())
      issues.push(
        issue(`skills.${skill.name || '<empty>'}`, 'Skill body is empty.', 'missing_skill_body'),
      );
    for (const tool of skill.tools)
      if (!spec.tools.includes(tool))
        issues.push(
          issue(
            `skills.${skill.name}.tools`,
            `Skill references unavailable tool '${tool}'.`,
            'unknown_skill_tool',
          ),
        );
    for (const connection of skill.mcp_connections)
      if (!spec.mcp_servers.includes(connection.id))
        issues.push(
          issue(
            `skills.${skill.name}.mcp_connections`,
            `Skill references unavailable MCP server '${connection.id}'.`,
            'unknown_skill_mcp',
          ),
        );
  }
  for (const schedule of spec.schedules) {
    try {
      parseSchedule(schedule.expression, schedule.timezone);
    } catch (cause) {
      issues.push(
        issue(
          `schedules.${schedule.id}`,
          cause instanceof Error ? cause.message : 'Invalid schedule.',
          'invalid_schedule',
        ),
      );
    }
  }
  return issues;
}

export function assertValidWorkspaceAgent(
  spec: WorkspaceAgentSpec,
  context: WorkspaceAgentValidationContext = {},
): void {
  const issues = validateWorkspaceAgent(spec, context);
  if (issues.length > 0) {
    throw new AgentRuntimeError(
      `Workspace agent '${spec.id}' is invalid: ${issues.map((entry) => entry.message).join(' ')}`,
      { code: 'invalid_workspace_agent' },
    );
  }
}

function duplicates(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  return [...new Set(values.filter((value) => seen.has(value) || !seen.add(value)))];
}

function checkKnown(
  values: readonly string[],
  known: ReadonlySet<string> | undefined,
  path: string,
  code: string,
  issues: WorkspaceAgentValidationIssue[],
): void {
  if (known === undefined) return;
  for (const value of values)
    if (!known.has(value)) issues.push(issue(path, `Unknown reference '${value}'.`, code));
}

function issue(path: string, message: string, code: string): WorkspaceAgentValidationIssue {
  return { path, message, code };
}

function isPortableName(value: string): boolean {
  return /^[a-z0-9][a-z0-9_-]*$/i.test(value) && !value.includes('..');
}
