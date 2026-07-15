import { UnsupportedCapabilityError } from './errors.js';
import type { TurnRequest } from '../providers/base.js';

export type CapabilityStatus = 'supported' | 'unsupported' | 'conditional' | 'passthrough';

export interface CapabilityDetail {
  readonly status: CapabilityStatus;
  readonly native_name?: string;
  readonly reason?: string;
  readonly supported_values?: readonly string[];
  readonly requires?: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface CapabilityConstraint {
  readonly all_of: readonly string[];
  readonly reason: string;
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
  readonly constraints?: readonly CapabilityConstraint[];
  readonly source?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ModelCapabilities {
  readonly streaming_events?: boolean;
  readonly function_tools?: boolean;
  readonly parallel_tool_calls?: boolean;
  readonly hosted_tools?: boolean;
  readonly mcp?: boolean;
  readonly workspaces?: boolean;
  readonly provider_state?: boolean;
  readonly structured_output?: boolean;
}

export type AgentCapabilityProfile = CapabilityProfile;

export function capability(
  status: CapabilityStatus,
  options: Omit<CapabilityDetail, 'status'> = {},
): CapabilityDetail {
  return { status, ...options };
}

export function assertCapabilitySupported(
  provider: string,
  capabilityName: string,
  detail: CapabilityDetail | undefined,
  options: { readonly allow_passthrough?: boolean; readonly value?: unknown } = {},
): void {
  const supported =
    detail?.status === 'supported' ||
    (detail?.status === 'passthrough' && options.allow_passthrough === true);
  if (!supported) {
    throw new UnsupportedCapabilityError(provider, capabilityName, detail);
  }

  if (
    options.value !== undefined &&
    detail.supported_values !== undefined &&
    !isSupportedValue(options.value, detail.supported_values)
  ) {
    throw new UnsupportedCapabilityError(provider, capabilityName, {
      reason: `Value '${displayValue(options.value)}' is not supported. Supported values: ${detail.supported_values.join(', ')}.`,
    });
  }
}

export function assertTurnRequestCapabilities(
  provider: string,
  request: TurnRequest,
  profile: CapabilityProfile,
): void {
  const requested = new Set<string>();

  if (request.tools !== undefined && request.tools.length > 0) {
    assertCapabilitySupported(provider, 'function_tools', profile.tools.function_tools);
    requested.add('tools.function_tools');
  }

  for (const hostedTool of request.hosted_tools ?? []) {
    const name = `hosted_tools.${hostedTool.type}`;
    assertCapabilitySupported(
      provider,
      name,
      profile.hosted_tools[hostedTool.type] ?? profile.hosted_tools.hosted_tools,
      { allow_passthrough: hostedTool.type === 'raw' },
    );
    requested.add(name);
  }

  if (request.mcp_connections !== undefined && request.mcp_connections.length > 0) {
    assertCapabilitySupported(
      provider,
      'mcp',
      profile.integrations.mcp ?? profile.hosted_tools.remote_mcp,
    );
    requested.add('integrations.mcp');
  }

  if (request.workspace !== undefined) {
    assertCapabilitySupported(
      provider,
      'workspace',
      profile.integrations.workspace ?? profile.integrations.workspaces,
    );
    requested.add('integrations.workspace');
  }

  if (request.provider_state !== undefined) {
    assertCapabilitySupported(
      provider,
      'provider_state',
      profile.state.provider_stateful ?? profile.state.provider_state,
    );
    requested.add('state.provider_stateful');
  }

  if (request.response_format?.type === 'json_schema') {
    assertCapabilitySupported(provider, 'structured_output', profile.output.structured_output);
    requested.add('output.structured_output');
  }

  if (request.output !== undefined) {
    const strategy = request.output.strategy;
    assertCapabilitySupported(
      provider,
      `output.${strategy}`,
      profile.output[strategy] ?? profile.output.structured_output,
      { value: strategy },
    );
    requested.add(`output.${strategy}`);
  }

  const controls: readonly [string, unknown, string?][] = [
    ['instructions', request.instructions],
    ['max_output_tokens', request.max_output_tokens ?? request.max_tokens],
    ['temperature', request.temperature],
    ['top_p', request.top_p],
    ['tool_choice', request.tool_choice],
    ['parallel_tool_calls', request.parallel_tool_calls],
    ['reasoning_effort', request.reasoning_effort],
    ['verbosity', request.verbosity],
    ['modalities', request.modalities],
    ['tool_search', request.tool_search],
    ['compaction', request.compaction],
    ['cache', request.cache],
    ['background', request.background],
    ['store', request.store],
    ['include', request.include],
    ['extra', request.extra, 'raw'],
  ];

  for (const [name, value, kind] of controls) {
    if (value === undefined) continue;
    assertCapabilitySupported(provider, `controls.${name}`, profile.controls[name], {
      allow_passthrough: kind === 'raw',
      value,
    });
    requested.add(`controls.${name}`);
  }

  if (request.state_mode !== undefined) {
    assertCapabilitySupported(
      provider,
      `state.${request.state_mode}`,
      profile.state[request.state_mode] ?? profile.controls.state_mode,
      { value: request.state_mode },
    );
    requested.add(`state.${request.state_mode}`);
  }

  for (const constraint of profile.constraints ?? []) {
    if (constraint.all_of.length > 0 && constraint.all_of.every((item) => requested.has(item))) {
      throw new UnsupportedCapabilityError(provider, constraint.all_of.join(' + '), {
        reason: constraint.reason,
      });
    }
  }
}

export function deriveCapabilityProfile(
  provider: string,
  capabilities: ModelCapabilities,
  model?: string,
): CapabilityProfile {
  const support = (value: boolean | undefined, reason: string) =>
    value === true ? capability('supported') : capability('unsupported', { reason });

  return {
    provider,
    model,
    summary: {
      supports_streaming_events: capabilities.streaming_events === true,
      supports_function_tools: capabilities.function_tools === true,
      supports_parallel_tool_calls: capabilities.parallel_tool_calls === true,
      supports_hosted_tools: capabilities.hosted_tools === true,
      supports_mcp: capabilities.mcp === true,
      supports_workspaces: capabilities.workspaces === true,
      supports_provider_state: capabilities.provider_state === true,
      supports_structured_output: capabilities.structured_output === true,
    },
    tools: {
      function_tools: support(capabilities.function_tools, 'Not advertised by the provider.'),
      parallel_tool_calls: support(
        capabilities.parallel_tool_calls,
        'Not advertised by the provider.',
      ),
    },
    hosted_tools: {
      hosted_tools: support(capabilities.hosted_tools, 'Not advertised by the provider.'),
    },
    output: {
      text: capability('supported'),
      structured_output: support(capabilities.structured_output, 'Not advertised by the provider.'),
    },
    controls: {},
    state: {
      provider_stateful: support(capabilities.provider_state, 'Not advertised by the provider.'),
      stateless_replay: capability('supported'),
    },
    integrations: {
      mcp: support(capabilities.mcp, 'Not advertised by the provider.'),
      workspace: support(capabilities.workspaces, 'Not advertised by the provider.'),
    },
    source: 'derived_compatibility_profile',
  };
}

export function textCompletionCapabilityProfile(
  provider: string,
  model?: string,
): CapabilityProfile {
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
      raw: capability('passthrough'),
    },
    output: {
      text: capability('supported'),
      structured_output: capability('unsupported'),
      provider_native: capability('unsupported'),
      finalizer_tool: capability('unsupported'),
      posthoc_parse: capability('supported'),
      posthoc_parse_with_retry: capability('unsupported'),
    },
    controls: {
      instructions: capability('supported'),
      max_output_tokens: capability('supported'),
      temperature: capability('supported'),
      top_p: capability('supported'),
      extra: capability('unsupported'),
    },
    state: {
      provider_stateful: capability('unsupported'),
      stateless_replay: capability('supported'),
    },
    integrations: {
      mcp: capability('unsupported'),
      workspace: capability('unsupported'),
    },
    source: 'blackbox-ts:text-completion-default',
  };
}

function isSupportedValue(value: unknown, supported: readonly string[]): boolean {
  if (Array.isArray(value)) return value.every((item) => supported.includes(String(item)));
  if (typeof value === 'object' && value !== null) return true;
  return supported.includes(String(value));
}

function displayValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
