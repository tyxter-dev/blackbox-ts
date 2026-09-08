import { toolResult, type ToolDefinition } from '../tools/types.js';
import type { Workspace } from './types.js';

/**
 * Canonical permission scopes per workspace operation.
 *
 * Mirrors the parent's operation table ((parent) src/blackbox/workspaces/tools.py
 * L257-269) for the four operations this port exposes as tools: reads and
 * listings are `read`, file writes are `write`, and commands are `execute`.
 * A package grant is written against the operation (`workspace:read`), not the
 * tool name, so a host that registers these definitions under its own prefix
 * keeps the same grant.
 */
const WORKSPACE_TOOL_SCOPES: Readonly<Record<string, readonly string[]>> = {
  read: ['read'],
  list: ['read'],
  write: ['write'],
  command: ['execute'],
};

export function workspaceToolDefinitions(workspace: Workspace): readonly ToolDefinition[] {
  const tools: ToolDefinition[] = [
    workspaceTool(workspace, 'read', {
      name: 'workspace_read',
      description: 'Read a UTF-8 file from the workspace.',
      input_schema: objectSchema({ path: { type: 'string' } }, ['path']),
      handler: async ({ path }) => {
        const resolvedPath = readString(path, 'path');
        const content = Buffer.from(await workspace.read(resolvedPath)).toString('utf8');
        return toolResult(content, { payload: { path: resolvedPath, content } });
      },
    }),
    workspaceTool(workspace, 'list', {
      name: 'workspace_list',
      description: 'List workspace files.',
      input_schema: objectSchema({ path: { type: 'string' } }),
      handler: async ({ path }) => workspace.list(typeof path === 'string' ? path : '.'),
    }),
  ];
  if (!workspace.readonly) {
    tools.push(
      workspaceTool(workspace, 'write', {
        name: 'workspace_write',
        description: 'Write a UTF-8 file in the workspace.',
        input_schema: objectSchema({ path: { type: 'string' }, content: { type: 'string' } }, [
          'path',
          'content',
        ]),
        side_effects: true,
        risk: 'high',
        handler: async ({ path, content }) => {
          await workspace.write(readString(path, 'path'), readString(content, 'content'));
          return 'written';
        },
      }),
      workspaceTool(workspace, 'command', {
        name: 'workspace_command',
        description: 'Execute an argument-safe command in the workspace.',
        input_schema: objectSchema(
          { program: { type: 'string' }, arguments: { type: 'array', items: { type: 'string' } } },
          ['program'],
        ),
        side_effects: true,
        risk: 'critical',
        handler: async ({ program, arguments: values }) => {
          const result = await workspace.command({
            program: readString(program, 'program'),
            arguments: Array.isArray(values)
              ? values.filter((value): value is string => typeof value === 'string')
              : [],
          });
          return toolResult(JSON.stringify(result), { payload: result });
        },
      }),
    );
  }
  return tools;
}

/**
 * Stamp the permission metadata a package boundary decides on.
 *
 * `category` plus `metadata.workspace_operation` are what turn a definition
 * into the canonical `workspace:<operation>` ref; without them a workspace
 * tool would fall back to its own name and no parent-shaped `workspace:*`
 * grant would match it.
 */
function workspaceTool(
  workspace: Workspace,
  operation: keyof typeof WORKSPACE_TOOL_SCOPES,
  definition: ToolDefinition,
): ToolDefinition {
  return {
    ...definition,
    category: 'workspace',
    tags: ['workspace'],
    scopes: WORKSPACE_TOOL_SCOPES[operation],
    metadata: {
      ...definition.metadata,
      workspace_operation: operation,
      ref: `workspace:${operation}`,
      workspace_id: workspace.id,
      workspace_kind: workspace.kind,
    },
  };
}

function objectSchema(
  properties: Readonly<Record<string, unknown>>,
  required: readonly string[] = [],
) {
  return { type: 'object', properties, required, additionalProperties: false };
}
function readString(value: unknown, name: string): string {
  if (typeof value !== 'string')
    throw new TypeError(`Workspace tool argument '${name}' must be a string.`);
  return value;
}
