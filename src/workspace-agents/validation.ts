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
