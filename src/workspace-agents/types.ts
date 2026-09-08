import type { SkillSpec } from '../skills/index.js';

export interface WorkspaceAgentConnector {
  readonly name: string;
  readonly type: string;
  readonly auth: 'none' | 'api_key' | 'oauth' | 'subscription' | (string & {});
  readonly scopes?: readonly string[];
  /**
   * Tool refs this connector may back. A grant that names this connector is
   * rejected at compile time unless the ref is listed here.
   */
  readonly tool_refs?: readonly string[];
  /**
   * `end_user` means each caller brings their own authorization;
   * `agent_owned` means the package points at a shared service credential
   * managed by the downstream application.
   */
  readonly auth_mode?: 'end_user' | 'agent_owned';
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Declarative approval requirement for a packaged agent capability. */
export interface WorkspaceAgentApprovalRequirement {
  readonly mode?: 'never' | 'on_write' | 'on_execute' | 'always' | 'policy' | (string & {});
  readonly reason?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Permission declaration for a local, hosted, MCP, or connector-backed tool. */
export interface WorkspaceAgentToolPermission {
  readonly ref: string;
  readonly scopes?: readonly (
    | 'read'
    | 'write'
    | 'delete'
    | 'execute'
    | 'admin'
    | 'custom'
    | (string & {})
  )[];
  readonly connector?: string;
  readonly approval?: WorkspaceAgentApprovalRequirement;
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
  /**
   * `allowlist_v1` marks the package as grant-restricted: validation compiles
   * {@link WorkspaceAgentSpec.grants} here and reports an invalid set, and the
   * compiled grants take effect once the host runs the package inside a
   * permission boundary. Absent or `inherit` keeps the host runtime's own
   * policy as the only gate.
   */
  readonly permission_mode?: 'inherit' | 'allowlist_v1';
  /** Compiled by `compilePackagePermissions` when `permission_mode` is `allowlist_v1`. */
  readonly grants?: readonly WorkspaceAgentToolPermission[];
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
