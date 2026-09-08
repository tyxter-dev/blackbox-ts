import { ConfigurationError } from '../core/errors.js';
import type { PolicyCheckpoint, PolicyRequest } from '../core/policy.js';
import { PackagePermissions, canonicalRef, type ToolGrant } from '../core/tool-permissions.js';
import type { AgentSpec } from '../providers/agent.js';
import { lowerWorkspaceAgentSpec } from './lowering.js';
import type {
  WorkspaceAgentConnector,
  WorkspaceAgentSpec,
  WorkspaceAgentToolPermission,
} from './types.js';

const APPROVAL_MODES: ReadonlySet<string> = new Set([
  'never',
  'on_write',
  'on_execute',
  'always',
  'policy',
]);

const PERMISSION_SCOPES: ReadonlySet<string> = new Set([
  'read',
  'write',
  'delete',
  'execute',
  'admin',
  'custom',
]);

/**
 * Snapshot grants; connector bindings must name a declared, matching connector.
 *
 * Every rejection is a {@link ConfigurationError} so an invalid package fails
 * before any tool is exposed rather than degrading to a partial allowlist.
 */
export function compilePackagePermissions(
  permissions: readonly WorkspaceAgentToolPermission[] = [],
  connectors: readonly WorkspaceAgentConnector[] = [],
): PackagePermissions {
  const connectorMap = new Map(connectors.map((connector) => [connector.name, connector]));
  if (connectorMap.size !== connectors.length) {
    throw new ConfigurationError('Duplicate package connector names.');
  }
  const grants: ToolGrant[] = [];
  const seen = new Set<string>();
  for (const permission of permissions) {
    const approvalMode = permission.approval?.mode ?? 'policy';
    if (!APPROVAL_MODES.has(approvalMode)) {
      throw new ConfigurationError('Invalid package approval mode.');
    }
    const ref = canonicalRef(permission.ref);
    if (seen.has(ref)) throw new ConfigurationError(`Duplicate package permission: ${ref}.`);
    seen.add(ref);
    const scopes = permission.scopes ?? ['read'];
    if (scopes.some((scope) => !PERMISSION_SCOPES.has(scope))) {
      throw new ConfigurationError(`Invalid permission scopes for ${ref}.`);
    }
    const connector = connectorMap.get(permission.connector ?? '');
    if (permission.connector !== undefined && connector === undefined) {
      throw new ConfigurationError(`Unknown connector: ${permission.connector}.`);
    }
    if (
      connector !== undefined &&
      !(connector.tool_refs ?? []).some((item) => canonicalRef(item) === ref)
    ) {
      throw new ConfigurationError(`Connector '${connector.name}' does not bind '${ref}'.`);
    }
    grants.push({
      ref,
      scopes: new Set(scopes),
      connector: permission.connector ?? null,
      connector_scopes: new Set(connector?.scopes ?? []),
      approval_mode: approvalMode,
      approval_reason: permission.approval?.reason,
    });
  }
  return new PackagePermissions(grants);
}

/**
 * Build the policy request for one declared permission. Security fields are
 * written after the caller's metadata so package metadata cannot claim a
 * connector or scopes the grant does not carry.
 */
export function toolPermissionPolicyRequest(
  permission: WorkspaceAgentToolPermission,
  options: {
    readonly agent_id: string;
    readonly checkpoint: PolicyCheckpoint;
    readonly action?: string;
    readonly arguments?: Readonly<Record<string, unknown>>;
  },
): PolicyRequest {
  return {
    checkpoint: options.checkpoint,
    action: options.action ?? permission.ref,
    arguments: { ...options.arguments },
    metadata: {
      ...permission.metadata,
      agent_id: options.agent_id,
      tool_ref: permission.ref,
      connector: permission.connector ?? null,
      scopes: [...(permission.scopes ?? ['read'])],
      approval_mode: permission.approval?.mode ?? 'policy',
    },
  };
}

/**
 * Lower an inherited package to a provider {@link AgentSpec}.
 *
 * A restricted package cannot be lowered: an `AgentSpec` carries no boundary,
 * so handing one to a provider would drop the allowlist.
 */
export function toAgentSpec(spec: WorkspaceAgentSpec): AgentSpec {
  if ((spec.permission_mode ?? 'inherit') !== 'inherit') {
    throw new ConfigurationError(
      'An allowlist_v1 package must run inside a permission boundary; AgentSpec alone cannot carry it.',
    );
  }
  return lowerWorkspaceAgentSpec(spec);
}
