export const PolicyCheckpoints = {
  BEFORE_MODEL_REQUEST: 'before_model_request',
  BEFORE_TOOL_EXPOSURE: 'before_tool_exposure',
  BEFORE_TOOL_CALL: 'before_tool_call',
  BEFORE_HOSTED_TOOL_CONFIG: 'before_hosted_tool_config',
  BEFORE_HOSTED_TOOL_CALL: 'before_hosted_tool_call',
  BEFORE_HOSTED_TOOL_RESULT: 'before_hosted_tool_result',
  BEFORE_HOSTED_ARTIFACT_EXPORT: 'before_hosted_artifact_export',
  BEFORE_MCP_CALL: 'before_mcp_call',
  BEFORE_WORKSPACE_OPEN: 'before_workspace_open',
  BEFORE_WORKSPACE_READ: 'before_workspace_read',
  BEFORE_WORKSPACE_WRITE: 'before_workspace_write',
  BEFORE_COMMAND: 'before_command',
  BEFORE_ARTIFACT_EXPORT: 'before_artifact_export',
  BEFORE_WORKSPACE_RESTORE: 'before_workspace_restore',
  BEFORE_PORT_EXPOSE: 'before_port_expose',
  BEFORE_FINAL_OUTPUT: 'before_final_output',
  BEFORE_AGENT_PUBLISH: 'before_agent_publish',
  BEFORE_CONNECTOR_BIND: 'before_connector_bind',
  BEFORE_SCHEDULED_RUN: 'before_scheduled_run',
  BEFORE_WORK_CLAIM: 'before_work_claim',
} as const;

export type PolicyCheckpoint = (typeof PolicyCheckpoints)[keyof typeof PolicyCheckpoints];
export type PolicyVerdict = 'allow' | 'deny' | 'require_approval';

export interface PolicyRequest {
  readonly checkpoint: PolicyCheckpoint;
  readonly action: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface PolicyDecision {
  readonly verdict: PolicyVerdict;
  readonly reason?: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface Policy {
  check(request: PolicyRequest): PolicyDecision | Promise<PolicyDecision>;
}

export function policyDecision(
  verdict: PolicyVerdict,
  reason?: string,
  metadata: Readonly<Record<string, unknown>> = {},
): PolicyDecision {
  return { verdict, reason, metadata };
}

export function allow(reason?: string): PolicyDecision {
  return policyDecision('allow', reason);
}

export function denyPolicy(reason?: string): PolicyDecision {
  return policyDecision('deny', reason);
}

export function requireApproval(reason?: string): PolicyDecision {
  return policyDecision('require_approval', reason);
}

export class AllowAllPolicy implements Policy {
  check(): PolicyDecision {
    return allow();
  }
}
