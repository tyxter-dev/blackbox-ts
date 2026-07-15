import type { SkillSpec } from '../skills/index.js';

export interface WorkspaceAgentConnector {
  readonly name: string;
  readonly type: string;
  readonly auth: 'none' | 'api_key' | 'oauth' | 'subscription' | (string & {});
  readonly scopes?: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface WorkspaceAgentPermissions {
  readonly tools?: readonly string[];
  readonly connectors?: readonly string[];
  readonly mcp_servers?: readonly string[];
  readonly workspace_read?: boolean;
  readonly workspace_write?: boolean;
  readonly commands?: boolean;
}

export interface WorkspaceAgentSchedule {
  readonly id: string;
  readonly expression: string;
  readonly timezone?: string;
  readonly input: string;
  readonly enabled?: boolean;
}

export interface WorkspaceAgentSpec {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly instructions: string;
  readonly model: string;
  readonly tools: readonly string[];
  readonly connectors: readonly WorkspaceAgentConnector[];
  readonly mcp_servers: readonly string[];
  readonly permissions: WorkspaceAgentPermissions;
  readonly schedules: readonly WorkspaceAgentSchedule[];
  readonly skills: readonly SkillSpec[];
  readonly visibility: 'private' | 'internal' | 'public';
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface WorkspaceAgentValidationContext {
  readonly tools?: ReadonlySet<string>;
  readonly connectors?: ReadonlySet<string>;
  readonly mcp_servers?: ReadonlySet<string>;
  readonly models?: ReadonlySet<string>;
}

export interface WorkspaceAgentValidationIssue {
  readonly path: string;
  readonly message: string;
  readonly code: string;
}

export interface WorkspaceAgentPackage {
  readonly format_version: 1;
  readonly agent: WorkspaceAgentSpec;
  readonly files: Readonly<Record<string, string>>;
}
