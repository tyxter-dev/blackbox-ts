import { readFile } from 'node:fs/promises';

import { ConfigurationError } from '../core/errors.js';
import { parseProviderModelRef } from '../core/refs.js';
import {
  allow,
  requireApproval,
  type Policy,
  type PolicyDecision,
  type PolicyRequest,
} from '../core/policy.js';
import type { AgentRunRequest } from '../runtime/agent-loop.js';

export type WorkflowSurface = 'model' | 'runtime' | 'agent_session' | 'realtime';

export type WorkflowProfileName =
  | 'fast_text'
  | 'structured_extraction'
  | 'tool_agent'
  | 'retrieval_agent'
  | 'coding_agent'
  | 'cloud_agent_session'
  | 'realtime_voice'
  | 'eval_run'
  | 'cost_sensitive'
  | 'high_reliability';

export interface RequiredConfigValue {
  readonly any_of: readonly string[];
  readonly reason: string;
}

export interface WorkflowProfile {
  readonly name: WorkflowProfileName;
  readonly description: string;
  readonly tradeoffs: string;
  readonly surfaces: readonly WorkflowSurface[];
  readonly defaults: Readonly<Record<string, unknown>>;
  readonly surface_defaults: Readonly<
    Partial<Record<WorkflowSurface, Readonly<Record<string, unknown>>>>
  >;
  readonly required: readonly RequiredConfigValue[];
  readonly required_capabilities: readonly string[];
  defaultsFor(surface?: WorkflowSurface): Record<string, unknown>;
}

export interface RuntimeConfigOptions {
  readonly profile?: string;
  readonly profile_name?: string;
  readonly overrides?: Readonly<Record<string, unknown>>;
  readonly source?: string;
}

export class RuntimeConfig {
  readonly profile_name?: WorkflowProfileName;
  readonly overrides: Readonly<Record<string, unknown>>;
  readonly source?: string;

  constructor(options: RuntimeConfigOptions = {}) {
    const requestedProfile = options.profile_name ?? options.profile;
    this.profile_name =
      requestedProfile === undefined ? undefined : getWorkflowProfile(requestedProfile).name;
    this.overrides = deepFreeze(clone(options.overrides ?? {}));
    this.source = options.source;
    Object.freeze(this);
  }

  /** Compatibility alias for consumers that previously read `config.profile`. */
  get profile(): WorkflowProfileName | undefined {
    return this.profile_name;
  }

  static profile(name: string): RuntimeConfig {
    return new RuntimeConfig({ profile_name: getWorkflowProfile(name).name });
  }

  static fromMapping(
    values: Readonly<Record<string, unknown>>,
    options: { readonly source?: string } = {},
  ): RuntimeConfig {
    const data: Record<string, unknown> = { ...clone(values) };
    const overrideBlock = data.overrides;
    if (
      overrideBlock !== undefined &&
      (typeof overrideBlock !== 'object' || overrideBlock === null || Array.isArray(overrideBlock))
    ) {
      throw new ConfigurationError("RuntimeConfig 'overrides' must be a mapping.");
    }
    delete data.overrides;
    const profile = readOptionalString(data.profile ?? data.profile_name);
    delete data.profile;
    delete data.profile_name;
    return new RuntimeConfig({
      profile_name: profile,
      overrides: {
        ...data,
        ...(overrideBlock as Readonly<Record<string, unknown>> | undefined),
      },
      source: options.source,
    });
  }

  static fromEnv(
    options: {
      readonly prefix?: string;
      readonly env?: Readonly<Record<string, string | undefined>>;
    } = {},
  ): RuntimeConfig {
    const prefix = options.prefix ?? 'AGENT_RUNTIME_';
    const env = options.env ?? process.env;
    const overrides: Record<string, unknown> = {};
    const profile = env[`${prefix}PROFILE`];
    for (const field of ENV_FIELDS) {
      const value = env[`${prefix}${field.suffix}`];
      if (value !== undefined) setPath(overrides, field.path, field.parse(value));
    }
    return new RuntimeConfig({ profile_name: profile, overrides, source: 'env' });
  }

  static async fromFile(path: string): Promise<RuntimeConfig> {
    const text = await readFile(path, 'utf8');
    const extension = path.slice(path.lastIndexOf('.')).toLowerCase();
    let payload: unknown;
    try {
      if (extension === '.json') payload = JSON.parse(text);
      else if (extension === '.toml') payload = parseToml(text);
      else if (extension === '.yaml' || extension === '.yml') {
        throw new ConfigurationError(
          'YAML runtime config files require an application-supplied YAML loader; JSON and TOML are dependency-free.',
        );
      } else {
        throw new ConfigurationError(`Unsupported runtime config file extension '${extension}'.`);
      }
    } catch (cause) {
      if (cause instanceof ConfigurationError) throw cause;
      throw new ConfigurationError(`Failed to parse runtime config '${path}'.`, { cause });
    }
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      throw new ConfigurationError('Runtime config file must contain a mapping.');
    }
    return RuntimeConfig.fromMapping(payload as Readonly<Record<string, unknown>>, {
      source: path,
    });
  }

  /** Load profile < environment < file < mapping in deterministic precedence order. */
  static async load(
    options: {
      readonly profile?: string;
      readonly prefix?: string;
      readonly env?: Readonly<Record<string, string | undefined>>;
      readonly file?: string;
      readonly mapping?: Readonly<Record<string, unknown>>;
    } = {},
  ): Promise<RuntimeConfig> {
    const environment = RuntimeConfig.fromEnv({ prefix: options.prefix, env: options.env });
    const file =
      options.file === undefined ? undefined : await RuntimeConfig.fromFile(options.file);
    const mapping =
      options.mapping === undefined ? undefined : RuntimeConfig.fromMapping(options.mapping);
    const profile =
      options.profile ?? mapping?.profile_name ?? file?.profile_name ?? environment.profile_name;
    return new RuntimeConfig({
      profile_name: profile,
      overrides: {
        ...environment.overrides,
        ...file?.overrides,
        ...mapping?.overrides,
      },
      source: mapping !== undefined ? 'mapping' : (file?.source ?? environment.source),
    });
  }

  withOverrides(overrides: Readonly<Record<string, unknown>>): RuntimeConfig {
    return new RuntimeConfig({
      profile_name: this.profile_name,
      overrides: { ...this.overrides, ...clone(overrides) },
      source: this.source,
    });
  }

  validate(surface?: WorkflowSurface): void {
    if (this.profile_name === undefined) return;
    const profile = getWorkflowProfile(this.profile_name);
    if (surface !== undefined && !profile.surfaces.includes(surface)) {
      throw new ConfigurationError(
        `Workflow profile '${profile.name}' cannot be used with the '${surface}' runtime surface.`,
      );
    }
    const values = this.mergedValues(surface);
    for (const requirement of profile.required) {
      if (!requirement.any_of.some((key) => hasValue(values, key))) {
        throw new ConfigurationError(
          `Workflow profile '${profile.name}' requires one of ${requirement.any_of.join(', ')}: ${requirement.reason}`,
        );
      }
    }
  }

  toValues(options: { readonly surface?: WorkflowSurface } = {}): Record<string, unknown> {
    this.validate(options.surface);
    const values = this.mergedValues(options.surface);
    normalizeProviderModel(values);
    return values;
  }

  /** Python-compatible naming for configuration adapters and migration code. */
  toKwargs(surface?: WorkflowSurface): Record<string, unknown> {
    return this.toValues({ surface });
  }

  resolveRun<T>(
    request: Partial<AgentRunRequest<T>> & Pick<AgentRunRequest<T>, 'input'>,
    surface: WorkflowSurface = 'runtime',
  ): AgentRunRequest<T> {
    const configured = this.toValues({ surface });
    if (request.model !== undefined && request.provider === undefined) {
      if (request.model.includes(':') || request.model.includes('/')) {
        delete configured.provider;
      } else {
        const configuredProvider = readOptionalString(configured.provider);
        if (
          configuredProvider !== undefined &&
          (configuredProvider.includes(':') || configuredProvider.includes('/'))
        ) {
          configured.provider = parseProviderModelRef(configuredProvider).provider;
        }
      }
    }
    const explicit = withoutUndefined(request);
    const merged = { ...configured, ...explicit } as Record<string, unknown>;
    const providerRef = readOptionalString(merged.provider);
    const model = readOptionalString(merged.model) ?? providerRef;
    if (model === undefined) {
      throw new ConfigurationError('Runtime config does not resolve a model.', {
        code: 'model_required',
      });
    }
    if (merged.model === undefined && providerRef?.includes(':')) delete merged.provider;
    merged.model = model;
    merged.trace_id = readOptionalString(merged.trace_id) ?? crypto.randomUUID();
    if (merged.approval_policy !== undefined && merged.policy === undefined) {
      merged.policy = workflowPolicy(merged.approval_policy);
    }
    delete merged.approval_policy;
    if (merged.tools === 'dynamic') {
      delete merged.tools;
      merged.tool_selection ??= 'dynamic';
    }
    delete merged.config;
    return merged as unknown as AgentRunRequest<T>;
  }

  describe(): Readonly<Record<string, unknown>> {
    const profile =
      this.profile_name === undefined ? undefined : getWorkflowProfile(this.profile_name);
    return {
      profile: this.profile_name,
      source: this.source,
      overrides: clone(this.overrides),
      description: profile?.description,
      tradeoffs: profile?.tradeoffs,
    };
  }

  private mergedValues(surface?: WorkflowSurface): Record<string, unknown> {
    return {
      ...(this.profile_name === undefined
        ? {}
        : getWorkflowProfile(this.profile_name).defaultsFor(surface)),
      ...clone(this.overrides),
    };
  }
}

export class RiskyActionApprovalPolicy implements Policy {
  check(request: PolicyRequest): PolicyDecision {
    if (RISKY_CHECKPOINTS.has(request.checkpoint) || looksRiskyAction(request.action)) {
      return requireApproval('Action requires approval under the risky_actions workflow policy.');
    }
    return allow();
  }
}

export function workflowPolicy(value: unknown): unknown {
  if (value === undefined || value === null || typeof value !== 'string') return value;
  if (value === 'risky_actions') return new RiskyActionApprovalPolicy();
  if (value === 'allow_all') return undefined;
  throw new ConfigurationError(`Unknown workflow policy '${value}'.`);
}

export function getWorkflowProfile(name: string): WorkflowProfile {
  const profile = WORKFLOW_PROFILES[name as WorkflowProfileName];
  if (profile === undefined) {
    throw new ConfigurationError(
      `Unknown workflow profile '${name}'. Known profiles: ${PROFILE_ORDER.join(', ')}.`,
    );
  }
  return profile;
}

export function workflowProfiles(): readonly WorkflowProfile[] {
  return PROFILE_ORDER.map((name) => WORKFLOW_PROFILES[name]);
}

export function workflowProfileDocs(): Readonly<Record<string, Readonly<Record<string, unknown>>>> {
  return Object.fromEntries(
    workflowProfiles().map((profile) => [
      profile.name,
      {
        description: profile.description,
        tradeoffs: profile.tradeoffs,
        surfaces: [...profile.surfaces],
        defaults: profile.defaultsFor(),
        surface_defaults: clone(profile.surface_defaults),
        required: clone(profile.required),
        required_capabilities: [...profile.required_capabilities],
      },
    ]),
  );
}

const PROFILE_ORDER: readonly WorkflowProfileName[] = [
  'fast_text',
  'structured_extraction',
  'tool_agent',
  'retrieval_agent',
  'coding_agent',
  'cloud_agent_session',
  'realtime_voice',
  'eval_run',
  'cost_sensitive',
  'high_reliability',
];

function workflowProfile(value: Omit<WorkflowProfile, 'defaultsFor'>): WorkflowProfile {
  const profile: WorkflowProfile = {
    ...value,
    defaults: deepFreeze(clone(value.defaults)),
    surface_defaults: deepFreeze(clone(value.surface_defaults)),
    required: deepFreeze(clone(value.required)),
    required_capabilities: Object.freeze([...value.required_capabilities]),
    surfaces: Object.freeze([...value.surfaces]),
    defaultsFor(surface) {
      return {
        ...clone(this.defaults),
        ...(surface === undefined ? {} : clone(this.surface_defaults[surface] ?? {})),
      };
    },
  };
  return Object.freeze(profile);
}

export const WORKFLOW_PROFILES: Readonly<Record<WorkflowProfileName, WorkflowProfile>> =
  Object.freeze({
    fast_text: workflowProfile({
      name: 'fast_text',
      description: 'Short text generation with minimal latency-oriented controls.',
      tradeoffs:
        'Keeps token budget and sampling low; not intended for tools, long reasoning, or strict schemas.',
      surfaces: ['model', 'runtime'],
      defaults: { temperature: 0.2, max_output_tokens: 512 },
      surface_defaults: { runtime: { max_iterations: 1 } },
      required: [],
      required_capabilities: [],
    }),
    structured_extraction: workflowProfile({
      name: 'structured_extraction',
      description: 'Deterministic structured data extraction using an explicit schema.',
      tradeoffs:
        'Requires a schema and prefers strict output over creativity; provider-native enforcement may fall back only when configured by the output spec.',
      surfaces: ['model', 'runtime'],
      defaults: { temperature: 0 },
      surface_defaults: { model: { output_strategy: 'provider_native' } },
      required: [
        {
          any_of: ['output_spec', 'output_schema', 'output_type'],
          reason: 'structured extraction needs a target schema.',
        },
      ],
      required_capabilities: ['structured_output'],
    }),
    tool_agent: workflowProfile({
      name: 'tool_agent',
      description: 'General tool-using agent loop with bounded dynamic tool exposure.',
      tradeoffs:
        'Enables more orchestration than text-only runs; providers without function tools or parallel tool controls may reject the request.',
      surfaces: ['runtime'],
      defaults: { parallel_tool_calls: true },
      surface_defaults: {
        runtime: {
          tool_selection: 'auto',
          tool_budget: { max_tools_visible: 16, max_parallel_calls: 4 },
        },
      },
      required: [
        {
          any_of: ['tools', 'toolsets', 'hosted_tools'],
          reason: 'tool_agent must have at least one tool source.',
        },
      ],
      required_capabilities: ['function_tools'],
    }),
    retrieval_agent: workflowProfile({
      name: 'retrieval_agent',
      description: 'Retrieval-heavy agent with provider tool search and conservative compaction.',
      tradeoffs:
        'Improves context discovery at the cost of additional tool/search latency and provider-specific support.',
      surfaces: ['model', 'runtime'],
      defaults: {
        tool_search: { enabled: true, max_results: 5 },
        compaction: { strategy: 'auto' },
      },
      surface_defaults: {},
      required: [
        {
          any_of: ['hosted_tools', 'toolsets', 'tools', 'data_sources', 'tool_search'],
          reason: 'retrieval_agent needs a retrieval source or tool-search control.',
        },
      ],
      required_capabilities: ['tool_search'],
    }),
    coding_agent: workflowProfile({
      name: 'coding_agent',
      description:
        'Workspace-oriented coding run with dynamic tools, cache, compaction, and risky-action approvals.',
      tradeoffs:
        'Assumes workspace access and can expose more tools; policy controls should be kept enabled for write and command actions.',
      surfaces: ['runtime'],
      defaults: {
        cache: { strategy: 'ephemeral' },
        compaction: { strategy: 'auto' },
        approval_policy: 'risky_actions',
      },
      surface_defaults: {
        runtime: {
          tools: 'dynamic',
          tool_selection: 'auto',
          max_iterations: 8,
          tool_budget: { max_tools_visible: 24, max_parallel_calls: 4 },
        },
      },
      required: [
        { any_of: ['workspace'], reason: 'coding_agent must know which workspace to operate on.' },
      ],
      required_capabilities: ['function_tools'],
    }),
    cloud_agent_session: workflowProfile({
      name: 'cloud_agent_session',
      description: 'Provider-managed agent session configuration for cloud agent adapters.',
      tradeoffs:
        'Delegates lifecycle and tool behavior to the agent provider; direct model-turn controls do not apply.',
      surfaces: ['agent_session'],
      defaults: { metadata: { workflow_profile: 'cloud_agent_session' } },
      surface_defaults: {},
      required: [
        { any_of: ['agent'], reason: 'cloud_agent_session must identify the managed agent.' },
      ],
      required_capabilities: ['agent_sessions'],
    }),
    realtime_voice: workflowProfile({
      name: 'realtime_voice',
      description: 'Realtime voice session with text/audio input and audio output defaults.',
      tradeoffs: 'Realtime transports are provider-specific and require audio-capable models.',
      surfaces: ['realtime'],
      defaults: {
        transport: 'websocket',
        tool_mode: 'manual',
        realtime_session: {
          input_modalities: ['text', 'audio'],
          output_modalities: ['text', 'audio'],
          audio: { voice: 'alloy' },
        },
      },
      surface_defaults: {},
      required: [],
      required_capabilities: ['realtime_audio'],
    }),
    eval_run: workflowProfile({
      name: 'eval_run',
      description:
        'Deterministic run shape intended for repeatable evaluations and trace comparison.',
      tradeoffs:
        'Low variance settings make evals easier to compare but can reduce creative exploration.',
      surfaces: ['model', 'runtime'],
      defaults: { temperature: 0, parallel_tool_calls: false },
      surface_defaults: { runtime: { context_flags: ['eval'] } },
      required: [],
      required_capabilities: [],
    }),
    cost_sensitive: workflowProfile({
      name: 'cost_sensitive',
      description:
        'Lower-cost run shape with reduced token and tool budgets plus cache-friendly defaults.',
      tradeoffs:
        'May truncate long answers or under-expose tools compared with reliability-oriented profiles.',
      surfaces: ['model', 'runtime'],
      defaults: {
        temperature: 0.2,
        max_output_tokens: 1024,
        cache: { strategy: 'auto' },
      },
      surface_defaults: {
        runtime: {
          max_iterations: 4,
          tool_budget: {
            max_tools_visible: 8,
            max_tool_calls: 8,
            max_parallel_calls: 2,
          },
        },
      },
      required: [],
      required_capabilities: [],
    }),
    high_reliability: workflowProfile({
      name: 'high_reliability',
      description:
        'Conservative high-accuracy settings with deterministic sampling and serialized tool calls.',
      tradeoffs:
        'Prefers careful responses over speed or cost; reasoning controls are provider/model dependent.',
      surfaces: ['model', 'runtime'],
      defaults: { temperature: 0, parallel_tool_calls: false, reasoning_effort: 'high' },
      surface_defaults: { runtime: { max_iterations: 12 } },
      required: [],
      required_capabilities: ['reasoning_effort'],
    }),
  });

const RISKY_CHECKPOINTS = new Set<PolicyRequest['checkpoint']>([
  'before_command',
  'before_workspace_write',
  'before_workspace_restore',
  'before_port_expose',
  'before_artifact_export',
  'before_hosted_tool_call',
  'before_hosted_artifact_export',
  'before_mcp_call',
  'before_agent_publish',
  'before_connector_bind',
  'before_scheduled_run',
]);

const RISKY_ACTION_MARKERS = new Set([
  'apply',
  'command',
  'delete',
  'deploy',
  'exec',
  'patch',
  'publish',
  'run',
  'shell',
  'write',
]);

function looksRiskyAction(action: string): boolean {
  const tokens = action
    .toLowerCase()
    .replace(/[:/\\.\- ]/g, '_')
    .split('_')
    .filter(Boolean);
  return tokens.some((token) => RISKY_ACTION_MARKERS.has(token));
}

interface EnvField {
  readonly suffix: string;
  readonly path: readonly string[];
  readonly parse: (value: string) => unknown;
}

const stringValue = (value: string): string => value;
const integerValue = (value: string): number => parseFiniteNumber(value, true);
const floatValue = (value: string): number => parseFiniteNumber(value, false);
const jsonValue = (value: string): unknown => JSON.parse(value);
const csvValue = (value: string): string[] =>
  value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

const ENV_FIELDS: readonly EnvField[] = [
  ['PROVIDER', ['provider'], stringValue],
  ['MODEL', ['model'], stringValue],
  ['INSTRUCTIONS', ['instructions'], stringValue],
  ['PROMPT_MODE', ['prompt_mode'], stringValue],
  ['CHANNEL', ['channel'], stringValue],
  ['TEMPERATURE', ['temperature'], floatValue],
  ['TOP_P', ['top_p'], floatValue],
  ['MAX_OUTPUT_TOKENS', ['max_output_tokens'], integerValue],
  ['MAX_ITERATIONS', ['max_iterations'], integerValue],
  ['TOOL_SELECTION', ['tool_selection'], stringValue],
  ['TOOLS', ['tools'], csvValue],
  ['TOOLS_JSON', ['tools'], jsonValue],
  ['HOSTED_TOOLS_JSON', ['hosted_tools'], jsonValue],
  ['TOOLSETS_JSON', ['toolsets'], jsonValue],
  ['TOOL_BUDGET_JSON', ['tool_budget'], jsonValue],
  ['TOOL_ROUTING_JSON', ['tool_routing'], jsonValue],
  ['TOOL_CHOICE_JSON', ['tool_choice'], jsonValue],
  ['PARALLEL_TOOL_CALLS', ['parallel_tool_calls'], booleanValue],
  ['REASONING_EFFORT', ['reasoning_effort'], stringValue],
  ['VERBOSITY', ['verbosity'], stringValue],
  ['STATE_MODE', ['state_mode'], stringValue],
  ['BACKGROUND', ['background'], booleanValue],
  ['STORE', ['store'], booleanValue],
  ['INCLUDE', ['include'], csvValue],
  ['MODALITIES', ['modalities'], csvValue],
  ['CACHE_JSON', ['cache'], jsonValue],
  ['CACHE_STRATEGY', ['cache', 'strategy'], stringValue],
  ['CACHE_KEY', ['cache', 'key'], stringValue],
  ['CACHE_TTL', ['cache', 'ttl'], stringValue],
  ['TOOL_SEARCH_JSON', ['tool_search'], jsonValue],
  ['TOOL_SEARCH_ENABLED', ['tool_search', 'enabled'], booleanValue],
  ['TOOL_SEARCH_MAX_RESULTS', ['tool_search', 'max_results'], integerValue],
  ['COMPACTION_JSON', ['compaction'], jsonValue],
  ['COMPACTION_STRATEGY', ['compaction', 'strategy'], stringValue],
  ['WORKSPACE_JSON', ['workspace'], jsonValue],
  ['WORKSPACE_PROVIDER', ['workspace_provider'], stringValue],
  ['OUTPUT_SPEC_JSON', ['output_spec'], jsonValue],
  ['OUTPUT_STRATEGY', ['output_strategy'], stringValue],
  ['OUTPUT_SCHEMA_JSON', ['output_schema'], jsonValue],
  ['APPROVAL_POLICY', ['approval_policy'], stringValue],
  ['POLICY', ['policy'], stringValue],
  ['DATA_SOURCES_JSON', ['data_sources'], jsonValue],
  ['CONTEXT_FLAGS', ['context_flags'], csvValue],
  ['TRANSPORT', ['transport'], stringValue],
  ['TOOL_MODE', ['tool_mode'], stringValue],
  ['REALTIME_SESSION_JSON', ['realtime_session'], jsonValue],
].map(([suffix, path, parse]) => ({ suffix, path, parse })) as readonly EnvField[];

function booleanValue(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new ConfigurationError(`Invalid boolean value '${value}'.`);
}

function parseFiniteNumber(value: string, integer: boolean): number {
  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed) || (integer && !Number.isInteger(parsed))) {
    throw new ConfigurationError(`Invalid ${integer ? 'integer' : 'number'} value '${value}'.`);
  }
  return parsed;
}

function setPath(target: Record<string, unknown>, path: readonly string[], value: unknown): void {
  let current = target;
  for (const part of path.slice(0, -1)) {
    const existing = current[part];
    if (existing === undefined) current[part] = {};
    else if (typeof existing !== 'object' || existing === null || Array.isArray(existing)) {
      throw new ConfigurationError(`Cannot merge env config into ${path.join('.')}.`);
    }
    current = current[part] as Record<string, unknown>;
  }
  const last = path.at(-1);
  if (last !== undefined) current[last] = value;
}

function hasValue(values: Readonly<Record<string, unknown>>, path: string): boolean {
  let current: unknown = values;
  for (const part of path.split('.')) {
    if (typeof current !== 'object' || current === null || !(part in current)) return false;
    current = (current as Readonly<Record<string, unknown>>)[part];
  }
  return current !== undefined && current !== null;
}

function normalizeProviderModel(values: Record<string, unknown>): void {
  const model = readOptionalString(values.model);
  if (model === undefined || (!model.includes(':') && !model.includes('/'))) return;
  const modelRef = parseProviderModelRef(model);
  const provider = readOptionalString(values.provider);
  if (provider === undefined) {
    values.provider = model;
    delete values.model;
    return;
  }
  const providerKey =
    provider.includes(':') || provider.includes('/')
      ? parseProviderModelRef(provider).provider
      : provider;
  if (providerKey !== modelRef.provider) {
    throw new ConfigurationError(
      `Configured provider '${providerKey}' does not match provider-qualified model '${model}'.`,
    );
  }
  values.provider = model;
  delete values.model;
}

function parseToml(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let target = result;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, '').trim();
    if (line === '') continue;
    const section = /^\[([^\]]+)\]$/.exec(line);
    if (section !== null) {
      const path =
        section[1]
          ?.split('.')
          .map((part) => part.trim())
          .filter(Boolean) ?? [];
      target = result;
      for (const part of path) {
        const existing = target[part];
        if (existing === undefined) target[part] = {};
        if (
          typeof target[part] !== 'object' ||
          target[part] === null ||
          Array.isArray(target[part])
        ) {
          throw new ConfigurationError(`Invalid TOML section '${section[1]}'.`);
        }
        target = target[part] as Record<string, unknown>;
      }
      continue;
    }
    const assignment = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (assignment === null || assignment[1] === undefined || assignment[2] === undefined) {
      throw new ConfigurationError(`Unsupported TOML syntax '${line}'.`);
    }
    target[assignment[1]] = parseTomlValue(assignment[2].trim());
  }
  return result;
}

function parseTomlValue(value: string): unknown {
  if (value.startsWith('"') && value.endsWith('"')) return JSON.parse(value);
  if (value === 'true' || value === 'false') return value === 'true';
  if (/^[+-]?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if (value.startsWith('[') && value.endsWith(']')) return JSON.parse(value);
  throw new ConfigurationError(`Unsupported TOML value '${value}'.`);
}

function readOptionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  throw new ConfigurationError('Expected a scalar string configuration value.');
}

function withoutUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, child]) => child !== undefined),
  ) as Partial<T>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
