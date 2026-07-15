import { toolResult, type ToolDefinition } from '../tools/types.js';
import type { Workspace } from './types.js';

export function workspaceToolDefinitions(workspace: Workspace): readonly ToolDefinition[] {
  const tools: ToolDefinition[] = [
    {
      name: 'workspace_read',
      description: 'Read a UTF-8 file from the workspace.',
      input_schema: objectSchema({ path: { type: 'string' } }, ['path']),
      handler: async ({ path }) => {
        const resolvedPath = readString(path, 'path');
        const content = Buffer.from(await workspace.read(resolvedPath)).toString('utf8');
        return toolResult(content, { payload: { path: resolvedPath, content } });
      },
    },
    {
      name: 'workspace_list',
      description: 'List workspace files.',
      input_schema: objectSchema({ path: { type: 'string' } }),
      handler: async ({ path }) => workspace.list(typeof path === 'string' ? path : '.'),
    },
  ];
  if (!workspace.readonly) {
    tools.push(
      {
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
      },
      {
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
      },
    );
  }
  return tools;
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
