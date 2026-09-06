import { UnsupportedFeatureError } from '../core/errors.js';
import type { AgentResult, AgentSessionResult } from '../core/results.js';
import { activePermissions, permissionBoundary } from '../core/tool-permissions.js';
import type { AgentRuntime, AgentRuntimeRequest } from '../runtime/agent-runtime.js';
import { lowerWorkspaceAgentSpec } from './lowering.js';
import { compilePackagePermissions } from './permissions.js';
import type { WorkspaceAgentSpec } from './types.js';

/**
 * Options for one packaged run.
 *
 * Everything an {@link AgentRuntime} run accepts is accepted here and wins over
 * the package, mirroring the parent's `**kwargs` override of the prepared run
 * arguments. Two package fields have no resolver in this port and therefore
 * arrive through these options instead of being invented:
 * `WorkspaceAgentSpec.mcp_servers` are bare server names, so MCP access is
 * whatever the caller passes as `mcp_connections` (or as MCP-backed `tools`),
 * and a workspace is whatever the caller passes as `workspace`.
 */
export type WorkspaceAgentRunOptions<T = string> = Omit<AgentRuntimeRequest<T>, 'input'> & {
  readonly input: string;
  /**
   * Run the package on an agent provider instead of the model loop. The parent
   * carries this on its spec; this port's {@link WorkspaceAgentSpec} has no
   * such field, so the caller names the provider here.
   */
  readonly agent_provider?: string;
};

/**
 * Run a packaged workspace agent inside an invocation-scoped permission
 * boundary.
 *
 * This is the only entry point in this library that compiles a package's
 * grants and enters their boundary: they are composed with any boundary
 * already active and held around the whole run, so exposure, routing,
 * dispatch and the MCP hop all decide against them. An `inherit` package runs
 * with whatever boundary the caller already holds -- including none.
 *
 * The preflight runs before any agent or session exists ((parent)
 * src/blackbox/workspace_agents/runtime.py L47-99): an adapter that cannot
 * enforce the boundary is refused here rather than after it has started work.
 */
export async function runWorkspaceAgent<T = string>(
  runtime: AgentRuntime,
  spec: WorkspaceAgentSpec,
  options: WorkspaceAgentRunOptions<T> & { readonly agent_provider: string },
): Promise<AgentSessionResult<T>>;
export async function runWorkspaceAgent<T = string>(
  runtime: AgentRuntime,
  spec: WorkspaceAgentSpec,
  options: WorkspaceAgentRunOptions<T> & { readonly agent_provider?: undefined },
): Promise<AgentResult<T>>;
export async function runWorkspaceAgent<T = string>(
  runtime: AgentRuntime,
  spec: WorkspaceAgentSpec,
  options: WorkspaceAgentRunOptions<T>,
): Promise<AgentResult<T> | AgentSessionResult<T>>;
export async function runWorkspaceAgent<T = string>(
  runtime: AgentRuntime,
  spec: WorkspaceAgentSpec,
  options: WorkspaceAgentRunOptions<T>,
): Promise<AgentResult<T> | AgentSessionResult<T>> {
  const compiled =
    spec.permission_mode === 'allowlist_v1'
      ? [compilePackagePermissions(spec.grants ?? [], spec.connectors)]
      : [];
  const permissions = [...activePermissions(), ...compiled];
  const provider = options.agent_provider;
  if (permissions.length > 0 && provider !== undefined) {
    const adapter = runtime.registry.getAgentProvider(provider);
    if (adapter.capabilities().supports_package_permissions !== true) {
      throw new UnsupportedFeatureError(
        'agent_package_permissions',
        'Agent provider cannot enforce allowlist_v1 package permissions.',
      );
    }
  }
  return permissionBoundary(permissions, async () =>
    provider === undefined
      ? runModelPackage<T>(runtime, spec, options)
      : runAgentProviderPackage<T>(runtime, spec, options, provider),
  );
}

/** Run the package through the model loop, the package's own fields first. */
async function runModelPackage<T>(
  runtime: AgentRuntime,
  spec: WorkspaceAgentSpec,
  options: WorkspaceAgentRunOptions<T>,
): Promise<AgentResult<T>> {
  return runtime.run<T>(runRequest(spec, options));
}

/**
 * Run the package on an agent provider.
 *
 * The spec is lowered through the private inherit path -- `toAgentSpec`
 * refuses a restricted package on purpose, and here the boundary is already
 * entered. The effective `model` and `instructions` (the caller's override,
 * else the package's) are written onto the lowered spec itself, because an
 * adapter reads them from the `AgentSpec` it is handed; tools, hosted
 * tools, workspace and policy travel on `metadata.run_request`, which is how
 * a local agent receives them.
 */
async function runAgentProviderPackage<T>(
  runtime: AgentRuntime,
  spec: WorkspaceAgentSpec,
  options: WorkspaceAgentRunOptions<T>,
  provider: string,
): Promise<AgentSessionResult<T>> {
  const { input, trace_id: traceId, ...request } = runRequest(spec, options);
  const lowered = lowerWorkspaceAgentSpec(spec);
  const agent = await runtime.agents.createAgent(provider, {
    ...lowered,
    model: request.model,
    instructions: request.instructions,
    metadata: { ...lowered.metadata, run_request: request },
  });
  const session = await runtime.agents.start(provider, agent, {
    input,
    ...(traceId === undefined ? {} : { trace_id: traceId }),
  });
  return runtime.agents.run<T>(session);
}

function runRequest<T>(
  spec: WorkspaceAgentSpec,
  options: WorkspaceAgentRunOptions<T>,
): AgentRuntimeRequest<T> & { readonly input: string } {
  const rest: Record<string, unknown> = { ...options };
  delete rest.agent_provider;
  return {
    ...(rest as AgentRuntimeRequest<T>),
    input: options.input,
    model: options.model ?? spec.model,
    instructions: options.instructions ?? spec.instructions,
    tools: options.tools ?? [...spec.tools],
  };
}
