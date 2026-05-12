export const AgentEventTypes = {
  MODEL_REQUEST_STARTED: 'model.request.started',
  MODEL_TEXT_DELTA: 'model.output.delta',
  MODEL_ITEM_CREATED: 'model.item.created',
  MODEL_ITEM_COMPLETED: 'model.item.completed',
  TOOL_CALL_REQUESTED: 'tool.call.requested',
  TOOL_CALL_COMPLETED: 'tool.call.completed',
  WORKSPACE_COMMAND_REQUESTED: 'workspace.command.requested',
  WORKSPACE_COMMAND_COMPLETED: 'workspace.command.completed',
  MODEL_COMPLETED: 'model.completed',
  MODEL_FAILED: 'model.failed',
} as const;

export type AgentEventType = (typeof AgentEventTypes)[keyof typeof AgentEventTypes];

export interface AgentEvent {
  readonly type: AgentEventType;
  readonly provider: string;
  readonly model?: string;
  readonly trace_id?: string;
  readonly data?: Readonly<Record<string, unknown>>;
  readonly raw?: unknown;
}
