import type { AgentSpec } from '../providers/agent.js';
import type { WorkspaceAgentSpec } from './types.js';

/**
 * Lower a package to a provider {@link AgentSpec}, without asking whether it
 * may be lowered.
 *
 * This module is deliberately not re-exported: the public entry point is
 * `toAgentSpec`, which refuses a restricted package because an `AgentSpec`
 * carries no boundary. `runWorkspaceAgent` uses this path instead, because it
 * has already entered the package's boundary around the run.
 */
export function lowerWorkspaceAgentSpec(spec: WorkspaceAgentSpec): AgentSpec {
  return {
    name: spec.name,
    instructions: spec.instructions,
    model: spec.model,
    metadata: {
      workspace_agent_id: spec.id,
      version: spec.version,
      skills: spec.skills.map((skill) => skill.name),
      ...spec.metadata,
    },
  };
}
