import {
  AgentRuntime,
  ProviderRegistry,
  ToolRegistry,
  type AgentRuntimeOptions,
} from 'blackbox-ts';

export interface RequestRuntimeDependencies {
  createRegistry(): ProviderRegistry;
  createTools(): ToolRegistry;
  runtime_options?: Omit<AgentRuntimeOptions, 'registry' | 'tools'>;
}

/**
 * Build a fresh request-scoped runtime from product-resolved dependencies. Tenant identity,
 * secret decryption, authorization, billing, and retention remain in the host application.
 */
export function createRequestRuntime(dependencies: RequestRuntimeDependencies): AgentRuntime {
  return new AgentRuntime({
    ...dependencies.runtime_options,
    registry: dependencies.createRegistry(),
    tools: dependencies.createTools(),
  });
}
