import { UnsupportedCapabilityError } from './errors.js';
import type { TurnRequest } from '../providers/base.js';

export type CapabilityStatus = 'supported' | 'unsupported' | 'conditional' | 'passthrough';

export interface CapabilityDetail {
  readonly status: CapabilityStatus;
  readonly native_name?: string;
  readonly reason?: string;
  readonly supported_values?: readonly string[];
  readonly requires?: readonly string[];
}

export interface AgentCapabilitySummary {
  readonly supports_streaming_events: boolean;
  readonly supports_function_tools: boolean;
  readonly supports_parallel_tool_calls: boolean;
  readonly supports_hosted_tools: boolean;
  readonly supports_mcp: boolean;
  readonly supports_workspaces: boolean;
  readonly supports_provider_state: boolean;
  readonly supports_structured_output: boolean;
}

export interface CapabilityProfile {
  readonly provider: string;
  readonly model?: string;
  readonly summary: AgentCapabilitySummary;
  readonly tools: Readonly<Record<string, CapabilityDetail>>;
  readonly hosted_tools: Readonly<Record<string, CapabilityDetail>>;
  readonly output: Readonly<Record<string, CapabilityDetail>>;
  readonly controls: Readonly<Record<string, CapabilityDetail>>;
  readonly state: Readonly<Record<string, CapabilityDetail>>;
  readonly integrations: Readonly<Record<string, CapabilityDetail>>;
}

export type AgentCapabilityProfile = CapabilityProfile;

export function capability(
  status: CapabilityStatus,
  options: {
    readonly native_name?: string;
    readonly reason?: string;
    readonly supported_values?: readonly string[];
    readonly requires?: readonly string[];
  } = {},
): CapabilityDetail {
  return { status, ...options };
}

export function assertCapabilitySupported(
  provider: string,
  capabilityName: string,
  detail: CapabilityDetail | undefined,
): void {
  if (detail?.status === 'supported' || detail?.status === 'passthrough') return;
  throw new UnsupportedCapabilityError(provider, capabilityName, detail);
}

export function assertTurnRequestCapabilities(provider: string, request: TurnRequest, profile: CapabilityProfile): void {
  if (request.tools && request.tools.length > 0) {
    assertCapabilitySupported(provider, 'function_tools', profile.tools.function_tools);
  }

  if (request.hosted_tools && request.hosted_tools.length > 0) {
    assertCapabilitySupported(provider, 'hosted_tools', profile.hosted_tools.hosted_tools);
  }

  if (request.mcp_connections && request.mcp_connections.length > 0) {
    assertCapabilitySupported(provider, 'mcp', profile.integrations.mcp ?? profile.hosted_tools.remote_mcp);
  }

  if (request.workspace) {
    assertCapabilitySupported(provider, 'workspace', profile.integrations.workspace ?? profile.integrations.workspaces);
  }

  if (request.provider_state) {
    assertCapabilitySupported(provider, 'provider_state', profile.state.provider_stateful ?? profile.state.provider_state);
  }

  if (request.response_format?.type === 'json_schema') {
    assertCapabilitySupported(provider, 'structured_output', profile.output.structured_output);
  }
}

export function textCompletionCapabilityProfile(provider: string, model?: string): CapabilityProfile {
  return {
    provider,
    model,
    summary: {
      supports_streaming_events: false,
      supports_function_tools: false,
      supports_parallel_tool_calls: false,
      supports_hosted_tools: false,
      supports_mcp: false,
      supports_workspaces: false,
      supports_provider_state: false,
      supports_structured_output: false,
    },
    tools: {
      function_tools: capability('unsupported', {
        reason: 'This adapter release only normalizes text turns.',
      }),
      parallel_tool_calls: capability('unsupported'),
    },
    hosted_tools: {
      hosted_tools: capability('unsupported'),
      web_search: capability('unsupported'),
      file_search: capability('unsupported'),
      code_interpreter: capability('unsupported'),
      remote_mcp: capability('unsupported'),
    },
    output: {
      text: capability('supported'),
      structured_output: capability('unsupported'),
    },
    controls: {
      instructions: capability('supported'),
      max_output_tokens: capability('supported'),
      temperature: capability('supported'),
      top_p: capability('supported'),
    },
    state: {
      provider_stateful: capability('unsupported'),
      stateless_replay: capability('supported'),
    },
    integrations: {
      mcp: capability('unsupported'),
      workspace: capability('unsupported'),
    },
  };
}
