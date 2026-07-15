import { createRuntimeId } from './ids.js';

export const AgentEventTypes = {
  RUN_STARTED: 'run.started',
  RUN_COMPLETED: 'run.completed',
  RUN_FAILED: 'run.failed',

  SESSION_CREATED: 'session.created',
  SESSION_STARTED: 'session.started',
  SESSION_COMPLETED: 'session.completed',
  SESSION_FAILED: 'session.failed',
  SESSION_CANCELLED: 'session.cancelled',

  MODEL_REQUEST_STARTED: 'model.request.started',
  MODEL_ITEM_CREATED: 'model.item.created',
  MODEL_ITEM_COMPLETED: 'model.item.completed',
  MODEL_TEXT_DELTA: 'model.text.delta',
  MODEL_REASONING_DELTA: 'model.reasoning.delta',
  MODEL_COMPLETED: 'model.completed',
  MODEL_FAILED: 'model.failed',

  REALTIME_SESSION_CONNECTING: 'realtime.session.connecting',
  REALTIME_SESSION_CONNECTED: 'realtime.session.connected',
  REALTIME_SESSION_UPDATED: 'realtime.session.updated',
  REALTIME_SESSION_CLOSED: 'realtime.session.closed',
  REALTIME_SESSION_FAILED: 'realtime.session.failed',
  REALTIME_TRANSPORT_RECONNECTING: 'realtime.transport.reconnecting',
  REALTIME_TRANSPORT_RECONNECTED: 'realtime.transport.reconnected',
  REALTIME_INPUT_ITEM_CREATED: 'realtime.input.item.created',
  REALTIME_INPUT_TEXT_SUBMITTED: 'realtime.input.text.submitted',
  REALTIME_INPUT_AUDIO_DELTA: 'realtime.input.audio.delta',
  REALTIME_INPUT_AUDIO_COMMITTED: 'realtime.input.audio.committed',
  REALTIME_INPUT_SPEECH_STARTED: 'realtime.input.speech.started',
  REALTIME_INPUT_SPEECH_STOPPED: 'realtime.input.speech.stopped',
  REALTIME_INPUT_TRANSCRIPT_DELTA: 'realtime.input.transcript.delta',
  REALTIME_INPUT_TRANSCRIPT_COMPLETED: 'realtime.input.transcript.completed',
  REALTIME_INPUT_IMAGE_ADDED: 'realtime.input.image.added',
  REALTIME_INPUT_VIDEO_FRAME_ADDED: 'realtime.input.video_frame.added',
  REALTIME_RESPONSE_CREATED: 'realtime.response.created',
  REALTIME_RESPONSE_COMPLETED: 'realtime.response.completed',
  REALTIME_RESPONSE_CANCELLED: 'realtime.response.cancelled',
  REALTIME_RESPONSE_FAILED: 'realtime.response.failed',
  REALTIME_OUTPUT_ITEM_CREATED: 'realtime.output.item.created',
  REALTIME_OUTPUT_ITEM_COMPLETED: 'realtime.output.item.completed',
  REALTIME_OUTPUT_TEXT_DELTA: 'realtime.output.text.delta',
  REALTIME_OUTPUT_TEXT_DONE: 'realtime.output.text.done',
  REALTIME_OUTPUT_AUDIO_DELTA: 'realtime.output.audio.delta',
  REALTIME_OUTPUT_AUDIO_DONE: 'realtime.output.audio.done',
  REALTIME_OUTPUT_AUDIO_TRANSCRIPT_DELTA: 'realtime.output.audio_transcript.delta',
  REALTIME_OUTPUT_AUDIO_TRANSCRIPT_DONE: 'realtime.output.audio_transcript.done',
  REALTIME_TURN_STARTED: 'realtime.turn.started',
  REALTIME_TURN_COMPLETED: 'realtime.turn.completed',
  REALTIME_INTERRUPTION_DETECTED: 'realtime.interruption.detected',
  REALTIME_OUTPUT_TRUNCATED: 'realtime.output.truncated',
  REALTIME_HISTORY_UPDATED: 'realtime.history.updated',
  REALTIME_USAGE_REPORTED: 'realtime.usage.reported',
  REALTIME_TOOL_ARGUMENTS_DELTA: 'realtime.tool.arguments.delta',

  TOOL_CALL_REQUESTED: 'tool.call.requested',
  TOOL_CALL_STARTED: 'tool.call.started',
  TOOL_CALL_COMPLETED: 'tool.call.completed',
  TOOL_CALL_FAILED: 'tool.call.failed',
  TOOL_ROUTING_STARTED: 'tool.routing.started',
  TOOL_ROUTING_COMPLETED: 'tool.routing.completed',
  TOOL_ROUTING_FAILED: 'tool.routing.failed',
  TOOL_ROUTING_LATE_BOUND: 'tool.routing.late_bound',
  TOOL_SET_CHANGED: 'tool.set.changed',
  AGENT_TOOL_CALL_STARTED: 'agent_tool.call.started',
  AGENT_TOOL_CALL_COMPLETED: 'agent_tool.call.completed',
  AGENT_TOOL_CALL_FAILED: 'agent_tool.call.failed',
  TOOL_SEARCH_REQUESTED: 'tool_search.requested',
  TOOL_SEARCH_COMPLETED: 'tool_search.completed',
  TOOL_CHOICE_SELECTED: 'tool.choice.selected',
  TOOL_CHOICE_REJECTED: 'tool.choice.rejected',
  TOOL_CHOICE_LOADED: 'tool.choice.loaded',
  TOOL_CHOICE_CALLED: 'tool.choice.called',
  TOOL_CHOICE_FAILED: 'tool.choice.failed',

  PROMPT_PLAN_CREATED: 'prompt.plan.created',
  PROMPT_FRAGMENT_SELECTED: 'prompt.fragment.selected',
  PROMPT_FRAGMENT_SKIPPED: 'prompt.fragment.skipped',
  PROMPT_BUNDLE_CREATED: 'prompt.bundle.created',
  PROMPT_PARITY_CHECKED: 'prompt.parity.checked',
  PROMPT_CACHE_SECTION_CREATED: 'prompt.cache_section.created',

  HOSTED_TOOL_CALL_REQUESTED: 'hosted_tool.call.requested',
  HOSTED_TOOL_CALL_STARTED: 'hosted_tool.call.started',
  HOSTED_TOOL_CALL_COMPLETED: 'hosted_tool.call.completed',
  HOSTED_TOOL_CALL_FAILED: 'hosted_tool.call.failed',
  HOSTED_TOOL_CALL_DENIED: 'hosted_tool.call.denied',
  HOSTED_TOOL_OUTPUT_PREPARED: 'hosted_tool.output.prepared',

  MCP_SERVER_STARTING: 'mcp.server.starting',
  MCP_SERVER_STARTED: 'mcp.server.started',
  MCP_SERVER_STOPPING: 'mcp.server.stopping',
  MCP_SERVER_STOPPED: 'mcp.server.stopped',
  MCP_SERVER_FAILED: 'mcp.server.failed',
  MCP_SERVER_STDERR: 'mcp.server.stderr',
  MCP_SERVER_VALIDATED: 'mcp.server.validated',
  MCP_SERVER_BLOCKED: 'mcp.server.blocked',
  MCP_TRUST_EVALUATED: 'mcp.trust.evaluated',
  MCP_ROUTE_SELECTED: 'mcp.route.selected',
  MCP_SESSION_BOUND: 'mcp.session.bound',
  MCP_AUTH_CHALLENGE: 'mcp.auth.challenge',
  MCP_LIST_TOOLS_STARTED: 'mcp.list_tools.started',
  MCP_LIST_TOOLS_COMPLETED: 'mcp.list_tools.completed',
  MCP_LIST_TOOLS_FAILED: 'mcp.list_tools.failed',
  MCP_TOOLS_DISCOVERED: 'mcp.tools.discovered',
  MCP_TOOLS_FILTERED: 'mcp.tools.filtered',
  MCP_TOOL_QUARANTINED: 'mcp.tool.quarantined',
  MCP_TOOLS_CACHE_HIT: 'mcp.tools.cache.hit',
  MCP_TOOLS_CACHE_MISS: 'mcp.tools.cache.miss',
  MCP_TOOLS_CACHE_INVALIDATED: 'mcp.tools.cache.invalidated',
  MCP_APPROVAL_REQUIRED: 'mcp.approval.required',
  MCP_CALL_APPROVAL_REQUIRED: 'mcp.call.approval_required',
  MCP_CALL_STARTED: 'mcp.call.started',
  MCP_CALL_COMPLETED: 'mcp.call.completed',
  MCP_CALL_FAILED: 'mcp.call.failed',
  MCP_OUTPUT_REDACTED: 'mcp.output.redacted',
  MCP_OUTPUT_TRUNCATED: 'mcp.output.truncated',
  MCP_CROSS_BOUNDARY_BLOCKED: 'mcp.cross_boundary.blocked',

  CLOUD_AGENT_STATUS_CHANGED: 'cloud_agent.status.changed',
  CLOUD_AGENT_LOG: 'cloud_agent.log',
  CLOUD_AGENT_CHECKPOINT_CREATED: 'cloud_agent.checkpoint.created',
  CLOUD_AGENT_WEBHOOK_RECEIVED: 'cloud_agent.webhook.received',
  CLOUD_AGENT_WEBHOOK_IGNORED: 'cloud_agent.webhook.ignored',
  AGENT_RESPONSE_MESSAGE_CREATED: 'agent.response.message.created',

  WORKSPACE_FILE_READ: 'workspace.file.read',
  WORKSPACE_FILE_CHANGED: 'workspace.file.changed',
  WORKSPACE_OPENED: 'workspace.opened',
  WORKSPACE_CLOSED: 'workspace.closed',
  WORKSPACE_FILE_LISTED: 'workspace.file.listed',
  WORKSPACE_COMMAND_REQUESTED: 'workspace.command.requested',
  WORKSPACE_COMMAND_STARTED: 'workspace.command.started',
  WORKSPACE_COMMAND_OUTPUT: 'workspace.command.output',
  WORKSPACE_COMMAND_COMPLETED: 'workspace.command.completed',
  WORKSPACE_TEST_STARTED: 'workspace.test.started',
  WORKSPACE_TEST_COMPLETED: 'workspace.test.completed',
  WORKSPACE_PATCH_CREATED: 'workspace.patch.created',
  WORKSPACE_SNAPSHOT_CREATED: 'workspace.snapshot.created',
  WORKSPACE_SNAPSHOT_RESTORED: 'workspace.snapshot.restored',
  WORKSPACE_PORT_EXPOSED: 'workspace.port.exposed',
  WORKSPACE_PORT_CLOSED: 'workspace.port.closed',
  WORKSPACE_ARTIFACT_EXPORTED: 'workspace.artifact.exported',

  APPROVAL_REQUESTED: 'approval.requested',
  APPROVAL_APPROVED: 'approval.approved',
  APPROVAL_DENIED: 'approval.denied',
  HANDOFF_REQUESTED: 'handoff.requested',
  HANDOFF_STARTED: 'handoff.started',
  HANDOFF_COMPLETED: 'handoff.completed',
  HANDOFF_FAILED: 'handoff.failed',
  GUARDRAIL_STARTED: 'guardrail.started',
  GUARDRAIL_COMPLETED: 'guardrail.completed',
  GUARDRAIL_FAILED: 'guardrail.failed',
  ARTIFACT_CREATED: 'artifact.created',
  ARTIFACT_UPDATED: 'artifact.updated',
  RETRY_STARTED: 'retry.started',
  RETRY_COMPLETED: 'retry.completed',
  RETRY_FAILED: 'retry.failed',
  EVAL_STARTED: 'eval.started',
  EVAL_COMPLETED: 'eval.completed',
  EVAL_FAILED: 'eval.failed',
} as const;

export type CanonicalAgentEventType = (typeof AgentEventTypes)[keyof typeof AgentEventTypes];
export type AgentEventType = CanonicalAgentEventType | (string & {});

export interface AgentEvent {
  readonly type: AgentEventType;
  readonly run_id?: string;
  readonly sequence?: number;
  readonly trace_id?: string;
  readonly span_id?: string;
  readonly parent_span_id?: string;
  readonly span_kind?: string;
  readonly session_id?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly item_id?: string;
  readonly provider_trace_id?: string;
  readonly provider_span_id?: string;
  readonly provider_request_id?: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly raw?: unknown;
  readonly id: string;
  readonly timestamp: string;
}

export type AgentEventInput = Omit<AgentEvent, 'data' | 'id' | 'timestamp'> & {
  readonly data?: Readonly<Record<string, unknown>>;
  readonly id?: string;
  readonly timestamp?: string;
};

export function createAgentEvent(input: AgentEventInput): AgentEvent {
  return {
    ...input,
    data: input.data ?? {},
    id: input.id ?? createRuntimeId('evt'),
    timestamp: input.timestamp ?? new Date().toISOString(),
  };
}
