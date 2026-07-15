import { createRuntimeId } from './ids.js';

export const RunItemTypes = {
  MESSAGE: 'message',
  REASONING: 'reasoning',
  FUNCTION_CALL: 'function_call',
  FUNCTION_RESULT: 'function_result',
  HOSTED_TOOL_CALL: 'hosted_tool_call',
  HOSTED_TOOL_RESULT: 'hosted_tool_result',
  TOOL_SEARCH_CALL: 'tool_search_call',
  TOOL_SEARCH_OUTPUT: 'tool_search_output',
  MCP_LIST_TOOLS: 'mcp_list_tools',
  MCP_CALL: 'mcp_call',
  MCP_APPROVAL_REQUEST: 'mcp_approval_request',
  HANDOFF_CALL: 'handoff_call',
  HANDOFF_RESULT: 'handoff_result',
  GUARDRAIL_RESULT: 'guardrail_result',
  APPROVAL_REQUEST: 'approval_request',
  APPROVAL_RESULT: 'approval_result',
  WORKSPACE_CHANGE: 'workspace_change',
  ARTIFACT: 'artifact',
  ERROR: 'error',
} as const;

export type RunItemType =
  | (typeof RunItemTypes)[keyof typeof RunItemTypes]
  | (string & Record<never, never>);
export type RunItemStatus = 'created' | 'in_progress' | 'completed' | 'failed' | 'requires_action';

export interface RunItem {
  readonly type: RunItemType;
  readonly provider: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly status?: RunItemStatus;
  readonly id: string;
  readonly parent_id?: string;
  readonly raw?: unknown;
}

export type RunItemInput = Omit<RunItem, 'id' | 'data'> & {
  readonly id?: string;
  readonly data?: Readonly<Record<string, unknown>>;
};

export function createRunItem(input: RunItemInput): RunItem {
  return {
    ...input,
    data: input.data ?? {},
    id: input.id ?? createRuntimeId('item'),
  };
}
