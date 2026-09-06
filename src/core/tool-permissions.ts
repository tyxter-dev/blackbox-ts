import { AsyncLocalStorage } from 'node:async_hooks';

import { ConfigurationError, UnsupportedFeatureError } from './errors.js';
import {
  allow,
  denyPolicy,
  requireApproval,
  type PolicyCheckpoint,
  type PolicyDecision,
  type PolicyRequest,
} from './policy.js';
import type { HostedToolSpec } from '../providers/base.js';
import type { ToolDefinition, ToolHandler } from '../tools/types.js';

/**
 * Immutable package constraints carried by the current run/session context.
 *
 * A grant is the compiled form of one declared package permission: it is
 * matched by exact canonical ref plus connector identity, and admits a call
 * only when the requested scopes are a subset of the granted scopes, or the
 * grant carries `admin`.
 */
export interface ToolGrant {
  readonly ref: string;
  readonly scopes: ReadonlySet<string>;
  readonly connector: string | null;
  readonly connector_scopes: ReadonlySet<string>;
  readonly approval_mode: string;
  readonly approval_reason?: string;
}

const WRITE_SCOPES: ReadonlySet<string> = new Set(['write', 'delete', 'admin']);
const EXECUTE_SCOPES: ReadonlySet<string> = new Set(['execute', 'admin']);

export class PackagePermissions {
  readonly grants: readonly ToolGrant[];

  constructor(grants: readonly ToolGrant[] = []) {
    // Snapshot every collection: compilation output must not follow later
    // mutations of the spec objects it was compiled from.
    this.grants = Object.freeze(
      grants.map((grant) =>
        Object.freeze({
          ...grant,
          scopes: new Set(grant.scopes),
          connector_scopes: new Set(grant.connector_scopes),
        }),
      ),
    );
  }

  decide(request: PolicyRequest, options: { readonly approvals?: boolean } = {}): PolicyDecision {
    const approvals = options.approvals ?? true;
    const metadata = request.metadata;
    const ref = canonicalRef(
      asText(truthy(metadata.tool_ref) ?? truthy(metadata.ref) ?? request.action),
    );
    const scopes = new Set(requestScopes(metadata));
    const connector: unknown = metadata.connector ?? null;
    const connectorScopes = new Set(stringList(metadata.connector_scopes));
    for (const grant of this.grants) {
      if (grant.ref !== ref || grant.connector !== connector) continue;
      if (!grant.scopes.has('admin') && !isSubset(scopes, grant.scopes)) continue;
      if (!isSubset(connectorScopes, grant.connector_scopes)) continue;
      const needsApproval =
        grant.approval_mode === 'always' ||
        (grant.approval_mode === 'on_write' && intersects(scopes, WRITE_SCOPES)) ||
        (grant.approval_mode === 'on_execute' && intersects(scopes, EXECUTE_SCOPES));
      if (approvals && needsApproval && request.checkpoint !== 'before_tool_exposure') {
        return requireApproval(grant.approval_reason);
      }
      return allow();
    }
    return denyPolicy(
      `Package permission denied '${ref}' for scopes ${JSON.stringify([...scopes].sort())}.`,
    );
  }
}

const NO_PERMISSIONS: readonly PackagePermissions[] = Object.freeze([]);
const activeStore = new AsyncLocalStorage<readonly PackagePermissions[]>();

export function activePermissions(): readonly PackagePermissions[] {
  return activeStore.getStore() ?? NO_PERMISSIONS;
}

/**
 * Run `body` inside a package permission boundary.
 *
 * The store is an async-local frame: every async continuation started inside
 * `body` sees the same constraints, and the frame is dropped when `body`
 * returns, throws, or is cancelled. Nested frames are composed by the caller
 * (pass `[...activePermissions(), next]`); `packageDecision` then denies when
 * any frame denies.
 */
export function permissionBoundary<T>(
  permissions: readonly PackagePermissions[],
  body: () => T,
): T {
  return activeStore.run(permissions, body);
}

/**
 * Re-enter `permissions` around every `next()`/`return()` of a consumer-driven
 * async iterator. An async generator body resumes in the async context of the
 * caller that pulled it, so a generator created inside a boundary but iterated
 * outside it would otherwise run its remaining steps unconstrained.
 */
export async function* permissionBoundaryIterator<T>(
  permissions: readonly PackagePermissions[],
  source: AsyncIterator<T>,
): AsyncGenerator<T> {
  try {
    for (;;) {
      const step = await permissionBoundary(permissions, async () => source.next());
      if (step.done === true) return;
      yield step.value;
    }
  } finally {
    if (source.return !== undefined) {
      await permissionBoundary(permissions, async () => source.return?.(undefined));
    }
  }
}

const HOSTED_REF_ALIASES: ReadonlyMap<string, string> = new Map([
  ['hosted:bash', 'hosted:shell'],
  ['hosted:computer_use', 'hosted:computer'],
]);

export function canonicalRef(ref: string): string {
  const aliased = HOSTED_REF_ALIASES.get(ref) ?? ref;
  return aliased.includes(':') ? aliased : `local:${aliased}`;
}

export function packageDecision(
  request: PolicyRequest,
  options: { readonly approvals?: boolean } = {},
): PolicyDecision {
  let approval: PolicyDecision | undefined;
  for (const permissions of activePermissions()) {
    const decision = permissions.decide(request, options);
    if (decision.verdict === 'deny') return decision;
    if (decision.verdict === 'require_approval') approval = decision;
  }
  return approval ?? allow();
}

export function toolRequest(
  definition: ToolDefinition,
  options: {
    readonly checkpoint?: PolicyCheckpoint;
    readonly arguments?: Readonly<Record<string, unknown>>;
  } = {},
): PolicyRequest {
  const metadata = { ...definition.metadata };
  let ref: string;
  if (definition.name.startsWith('mcp:')) {
    ref = definition.name;
  } else if (definition.category === 'workspace') {
    const operation =
      truthy(metadata.workspace_operation) ??
      (partitionAfter(definition.name, '_') || definition.name);
    ref = `workspace:${asText(operation)}`;
  } else {
    ref = canonicalRef(definition.name);
  }
  const scopes = [...(definition.scopes ?? [])];
  const mcpName = definition.name.startsWith('mcp:') ? definition.name.slice(4) : undefined;
  return {
    checkpoint: options.checkpoint ?? 'before_tool_exposure',
    action: definition.name,
    arguments: { ...options.arguments },
    metadata: {
      category: definition.category,
      tags: [...(definition.tags ?? [])],
      risk: definition.risk,
      side_effects: definition.side_effects,
      latency: definition.latency,
      cost: definition.cost,
      ...(mcpName === undefined
        ? {}
        : {
            server: mcpName.slice(0, mcpName.includes('.') ? mcpName.indexOf('.') : mcpName.length),
            tool: partitionAfter(mcpName, '.'),
          }),
      tool_metadata: metadata,
      tool_ref: ref,
      ref,
      scopes,
      permission_scopes: scopes.length > 0 ? scopes : ['execute'],
      connector: metadata.connector ?? null,
      connector_scopes: stringList(metadata.connector_scopes),
    },
  };
}

const discoveryHandlers = new WeakSet<ToolHandler>();

/**
 * Mark a handler as a runtime-owned tool-discovery meta tool. Discovery stays
 * reachable inside a package boundary; identity (not the tool name) decides,
 * so a registered tool that merely borrows the name is still enforced.
 */
export function markInternalDiscoveryTool<T extends ToolHandler>(handler: T): T {
  discoveryHandlers.add(handler);
  return handler;
}

export function internalDiscoveryTool(definition: ToolDefinition): boolean {
  return definition.handler !== undefined && discoveryHandlers.has(definition.handler);
}

export function definitionAllowed(definition: ToolDefinition): boolean {
  return (
    internalDiscoveryTool(definition) || packageDecision(toolRequest(definition)).verdict !== 'deny'
  );
}

export function hostedRequest(
  kind: string,
  options: { readonly checkpoint?: PolicyCheckpoint } = {},
): PolicyRequest {
  return {
    checkpoint: options.checkpoint ?? 'before_hosted_tool_call',
    action: kind,
    arguments: {},
    metadata: {
      tool_ref: `hosted:${kind}`,
      scopes: kind === 'web_search' ? ['read'] : ['execute'],
      connector: null,
      connector_scopes: [],
    },
  };
}

const CLIENT_EXECUTED_HOSTED_KINDS: ReadonlySet<string> = new Set([
  'apply_patch',
  'computer',
  'memory',
  'text_editor',
  'shell',
]);

/**
 * Classify a hosted spec by the type the adapters actually emit.
 *
 * The OpenAI Responses mapping (inherited unchanged by xAI) and the Anthropic
 * web-search branch emit `{ type, ...(config ?? {}) }` with config spread
 * last, so there a `config.type` overrides the declared `type` on the wire --
 * the Anthropic branch relies on it to pin a versioned web-search type. Gemini
 * instead nests config under its own key and emits no top-level type, so no
 * override reaches that wire and this gate is stricter than Gemini needs.
 * Classifying on the effective type keeps the gate in step with the adapters
 * that can be overridden: a config type naming a different kind fails closed,
 * with one allowance for the versioned web search (`web_search_<version>`),
 * which stays the same kind.
 */
export function hostedToolKind(spec: HostedToolSpec): string {
  const declared = canonicalRef(`hosted:${spec.type}`).slice('hosted:'.length);
  const override = spec.config?.type;
  if (typeof override !== 'string' || override === spec.type) return declared;
  const effective =
    declared === 'web_search' && (override === 'web_search' || override.startsWith('web_search_'))
      ? 'web_search'
      : canonicalRef(`hosted:${override}`).slice('hosted:'.length);
  if (effective !== declared) {
    throw new UnsupportedFeatureError(
      `allowlist_v1 cannot enforce hosted tool '${spec.type}' configured as '${override}'.`,
    );
  }
  return declared;
}

/**
 * Allow client-executed hosted contracts; reject opaque native execution.
 *
 * Under a package boundary only hosted tools this process itself executes can
 * be enforced per call, so anything else fails closed before dispatch.
 */
export function validatePackageModelConfig(
  hostedTools: readonly HostedToolSpec[],
  extra: Readonly<Record<string, unknown>> = {},
): readonly HostedToolSpec[] {
  if (activePermissions().length === 0) return hostedTools;
  if (Object.keys(extra).length > 0) {
    throw new ConfigurationError('allowlist_v1 does not support provider-native extra parameters.');
  }
  const allowed: HostedToolSpec[] = [];
  for (const spec of hostedTools) {
    const kind = hostedToolKind(spec);
    if (kind === 'web_search') {
      const decision = packageDecision(
        hostedRequest('web_search', { checkpoint: 'before_hosted_tool_config' }),
      );
      if (decision.verdict === 'require_approval') {
        throw new UnsupportedFeatureError('WebSearch cannot enforce package per-call approval.');
      }
      if (decision.verdict === 'allow') allowed.push(spec);
      continue;
    }
    if (!CLIENT_EXECUTED_HOSTED_KINDS.has(kind)) {
      throw new UnsupportedFeatureError(
        'allowlist_v1 cannot enforce provider-executed hosted tools or RemoteMCP.',
      );
    }
    if (kind === 'shell' && spec.config?.execution !== 'local') {
      throw new UnsupportedFeatureError("allowlist_v1 requires shell execution 'local'.");
    }
    const decision = packageDecision(hostedRequest(kind, { checkpoint: 'before_tool_exposure' }));
    if (decision.verdict !== 'deny') allowed.push(spec);
  }
  return allowed;
}

let nextIdentityToken = 0;
const identityTokens = new WeakMap<object, string>();

function identityToken(value: object): string {
  const existing = identityTokens.get(value);
  if (existing !== undefined) return existing;
  const token = `#${(nextIdentityToken += 1)}`;
  identityTokens.set(value, token);
  return token;
}

/**
 * Bind an approval to the callable and its authoritative permission
 * requirements: replacing the handler or editing the permission metadata
 * between approval and dispatch produces a different key.
 */
export function approvalKey(definition: ToolDefinition): string {
  const request = toolRequest(definition);
  const identity = identityToken(definition.handler ?? definition);
  return `${definition.name} ${identity} ${stableRepr(request.metadata)}`;
}

const NO_APPROVALS: ReadonlySet<string> = Object.freeze(new Set<string>());
const approvedStore = new AsyncLocalStorage<ReadonlySet<string>>();

function requestKey(request: PolicyRequest): string {
  const metadata = request.metadata;
  const ref = canonicalRef(
    asText(truthy(metadata.tool_ref) ?? truthy(metadata.ref) ?? request.action),
  );
  const scopes = [...requestScopes(metadata)].sort();
  const connector = metadata.connector ?? null;
  const connectorScopes = [...stringList(metadata.connector_scopes)].sort();
  return stableRepr([ref, scopes, connector, connectorScopes]);
}

export function approvedPackageCall<T>(request: PolicyRequest | undefined, body: () => T): T {
  if (request === undefined) return body();
  const approved = new Set(approvedStore.getStore() ?? NO_APPROVALS);
  approved.add(requestKey(request));
  return approvedStore.run(approved, body);
}

export function packageCallApproved(request: PolicyRequest): boolean {
  return (approvedStore.getStore() ?? NO_APPROVALS).has(requestKey(request));
}

/** Total, lint-safe stringification; objects keep a stable, non-matching form. */
function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null) return stableRepr(value);
  if (typeof value === 'symbol') return value.toString();
  if (value === undefined || value === null) return String(value);
  return `${value as number | boolean | bigint}`;
}

function truthy(value: unknown): unknown {
  if (value === undefined || value === null || value === '' || value === false) return undefined;
  if (Array.isArray(value) && value.length === 0) return undefined;
  return value;
}

function requestScopes(metadata: Readonly<Record<string, unknown>>): readonly string[] {
  const declared = truthy(metadata.permission_scopes) ?? truthy(metadata.scopes);
  const scopes = stringList(declared);
  return scopes.length > 0 ? scopes : ['execute'];
}

function stringList(value: unknown): readonly string[] {
  // Non-string members are stringified rather than dropped: an unexpected
  // member must still fail the subset check instead of disappearing. A truthy
  // non-array value is kept as one opaque member for the same reason -- it must
  // not collapse to the empty list and pick up the default scope.
  if (Array.isArray(value)) return value.map((entry) => asText(entry));
  return truthy(value) === undefined ? [] : [asText(value)];
}

function isSubset(candidate: ReadonlySet<string>, container: ReadonlySet<string>): boolean {
  for (const value of candidate) if (!container.has(value)) return false;
  return true;
}

function intersects(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  for (const value of left) if (right.has(value)) return true;
  return false;
}

function partitionAfter(value: string, separator: string): string {
  const index = value.indexOf(separator);
  return index < 0 ? '' : value.slice(index + separator.length);
}

/** Deterministic, total representation used for approval identity. */
function stableRepr(value: unknown, seen: Set<object> = new Set()): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'undefined') return 'undefined';
  if (typeof value === 'function') return `fn:${identityToken(value)}`;
  if (typeof value === 'symbol') return `sym:${String(value)}`;
  if (typeof value === 'object') {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        return `[${value.map((entry) => stableRepr(entry, seen)).join(',')}]`;
      }
      if (value instanceof Set) {
        return `Set[${[...value]
          .map((entry) => stableRepr(entry, seen))
          .sort()
          .join(',')}]`;
      }
      if (value instanceof Map) {
        return `Map[${[...value.entries()]
          .map(([key, entry]) => `${stableRepr(key, seen)}:${stableRepr(entry, seen)}`)
          .sort()
          .join(',')}]`;
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      return `{${keys.map((key) => `${JSON.stringify(key)}:${stableRepr(record[key], seen)}`).join(',')}}`;
    } finally {
      seen.delete(value);
    }
  }
  return '[unrepresentable]';
}
