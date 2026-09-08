import { AgentRuntimeError, ConfigurationError } from '../core/errors.js';
import { parseProviderModelRef } from '../core/refs.js';
import type { HostedToolSpec } from '../providers/base.js';
import type { WorkspaceAgentRunOptions } from './runtime.js';
import type {
  WorkspaceAgentConnector,
  WorkspaceAgentSpec,
  WorkspaceAgentToolPermission,
} from './types.js';
import { compilePackagePermissions } from './permissions.js';
import { assertValidWorkspaceAgent } from './validation.js';

export interface PythonWorkspaceAgentImportOptions {
  readonly connector_auth?: Readonly<Record<string, WorkspaceAgentConnector['auth']>>;
}

export interface ImportedPythonWorkspaceAgentPackage {
  readonly source: 'python';
  readonly spec: WorkspaceAgentSpec;
  readonly run_options: Omit<WorkspaceAgentRunOptions, 'input'>;
}

const WORKSPACE_OPERATIONS: ReadonlyMap<string, string> = new Map([
  ['read_file', 'read'],
  ['list_files', 'list'],
  ['write_file', 'write'],
  ['run_command', 'command'],
]);

// This module is internal; the public ZIP entrypoint first applies the native
// archive integrity, path, encoding and size checks before calling this projection.
export function translatePythonPackage(
  files: ReadonlyMap<string, Uint8Array>,
  options: PythonWorkspaceAgentImportOptions,
): ImportedPythonWorkspaceAgentPackage {
  const manifestBytes = files.get('agent.json');
  const instructionsBytes = files.get('instructions.md');
  if (manifestBytes === undefined || instructionsBytes === undefined) {
    throw new AgentRuntimeError('Python package requires agent.json and instructions.md.', {
      code: 'malformed_agent_package',
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeText(manifestBytes));
  } catch (cause) {
    throw new AgentRuntimeError('Python package manifest is not valid JSON.', {
      code: 'malformed_agent_package',
      cause,
    });
  }
  const manifest = fields(parsed, 'manifest', ['format', 'format_version', 'spec']);
  if (manifest.format !== 'blackbox/workspace-agent' || manifest.format_version !== 1) {
    unsupported('format', 'requires blackbox/workspace-agent format version 1');
  }
  const source = fields(manifest.spec, 'spec', [
    'id',
    'name',
    'instructions',
    'model_provider',
    'model',
    'agent_provider',
    'agent_id',
    'tools',
    'hosted_tools',
    'mcp_servers',
    'mcp_toolsets',
    'connectors',
    'permissions',
    'schedules',
    'skills',
    'memory',
    'publication',
    'version',
    'metadata',
    'extra',
    'permission_mode',
  ]);
  const instructions = decodeText(instructionsBytes);
  if (
    source.instructions !== undefined &&
    string(source.instructions, 'instructions', true) !== instructions
  ) {
    invalid('instructions', 'conflicts with instructions.md');
  }
  const agentProvider = optionalString(source.agent_provider, 'agent_provider');
  if (agentProvider !== undefined && agentProvider !== 'local') {
    unsupported(
      'agent_provider',
      'only the local agent provider consumes the translated run options',
    );
  }
  if (optionalString(source.agent_id, 'agent_id') !== undefined) {
    unsupported('agent_id', 'existing-agent selection has no native package equivalent');
  }
  for (const field of ['mcp_servers', 'mcp_toolsets', 'skills', 'schedules']) {
    if (array(source[field], field).length > 0) {
      unsupported(field, 'requires host-side translation of its execution semantics');
    }
  }
  for (const path of files.keys()) {
    if (path !== 'agent.json' && path !== 'instructions.md') {
      unsupported(path, 'extra archive files have no destination in this importer');
    }
  }
  const memory = fields(source.memory === undefined ? {} : source.memory, 'memory', [
    'mode',
    'retention_days',
    'metadata',
  ]);
  if (
    (memory.mode === undefined ? 'none' : memory.mode) !== 'none' ||
    memory.retention_days != null
  ) {
    unsupported('memory', 'only mode none with no retention setting is representable');
  }
  record(memory.metadata === undefined ? {} : memory.metadata, 'memory.metadata');
  const publication = fields(
    source.publication === undefined ? {} : source.publication,
    'publication',
    ['visibility', 'directory_enabled', 'approved', 'channels', 'metadata'],
  );
  const visibility = publication.visibility === undefined ? 'private' : publication.visibility;
  if (visibility !== 'private' && visibility !== 'public') {
    unsupported('publication.visibility', 'only private/public have direct native equivalents');
  }
  for (const field of ['directory_enabled', 'approved']) {
    if (publication[field] !== undefined && publication[field] !== false) {
      unsupported(`publication.${field}`, 'must be false');
    }
  }
  if (strings(publication.channels, 'publication.channels').length > 0) {
    unsupported('publication.channels', 'channel publishing belongs to the host');
  }
  record(publication.metadata === undefined ? {} : publication.metadata, 'publication.metadata');
  const version = fields(source.version, 'version', [
    'version',
    'changelog',
    'previous_version',
    'metadata',
  ]);
  optionalString(version.changelog, 'version.changelog', true);
  optionalString(version.previous_version, 'version.previous_version');
  record(version.metadata === undefined ? {} : version.metadata, 'version.metadata');
  const metadata = fields(source.metadata === undefined ? {} : source.metadata, 'metadata', [
    'owner',
    'description',
    'labels',
    'created_by',
    'metadata',
  ]);
  optionalString(metadata.owner, 'metadata.owner');
  optionalString(metadata.description, 'metadata.description', true);
  optionalString(metadata.created_by, 'metadata.created_by');
  strings(metadata.labels, 'metadata.labels');
  record(metadata.metadata === undefined ? {} : metadata.metadata, 'metadata.metadata');
  fields(options, 'options', ['connector_auth']);
  const auth = record(
    options.connector_auth === undefined ? {} : options.connector_auth,
    'options.connector_auth',
  );
  const connectors = array(source.connectors, 'connectors').map((value, index) =>
    connector(value, `connectors[${index}]`, auth),
  );
  for (const name of Object.keys(auth)) {
    if (!connectors.some((item) => item.name === name))
      invalid('connector_auth', `unknown connector '${name}'`);
  }
  const grants = array(source.permissions, 'permissions').map((value, index) =>
    grant(value, `permissions[${index}]`),
  );
  // Validate grant shape and connector bindings even for inherit-mode packages;
  // import never makes malformed authority look like a valid native declaration.
  compilePackagePermissions(grants, connectors);
  const mode = source.permission_mode === undefined ? 'inherit' : source.permission_mode;
  if (mode !== 'inherit' && mode !== 'allowlist_v1') invalid('permission_mode', 'unknown mode');
  const hostedTools = array(source.hosted_tools, 'hosted_tools').map((value, index) =>
    hostedTool(value, `hosted_tools[${index}]`),
  );
  const extra = record(source.extra === undefined ? {} : source.extra, 'extra');
  const spec: WorkspaceAgentSpec = {
    id: string(source.id, 'id'),
    name: string(source.name, 'name'),
    version: string(version.version, 'version.version'),
    instructions,
    model: modelRef(source.model, source.model_provider),
    tools: strings(source.tools, 'tools').map(translateToolName),
    connectors,
    mcp_servers: [],
    permissions: {},
    permission_mode: mode,
    grants,
    schedules: [],
    skills: [],
    visibility,
    metadata: { python_package: { version, metadata, memory, publication } },
  };
  assertValidWorkspaceAgent(spec);
  return {
    source: 'python',
    spec,
    run_options: {
      ...(agentProvider === undefined ? {} : { agent_provider: agentProvider }),
      ...(hostedTools.length === 0 ? {} : { hosted_tools: hostedTools }),
      ...(Object.keys(extra).length === 0 ? {} : { extra }),
    },
  };
}

function connector(
  value: unknown,
  path: string,
  auth: Readonly<Record<string, unknown>>,
): WorkspaceAgentConnector {
  const source = fields(value, path, [
    'name',
    'kind',
    'auth_mode',
    'scopes',
    'tool_refs',
    'metadata',
  ]);
  const name = string(source.name, `${path}.name`);
  if (!Object.hasOwn(auth, name)) invalid(path, `connector_auth must explicitly name '${name}'`);
  const mode = source.auth_mode === undefined ? 'end_user' : source.auth_mode;
  if (mode !== 'end_user' && mode !== 'agent_owned') invalid(`${path}.auth_mode`, 'unknown mode');
  return {
    name,
    type: string(source.kind, `${path}.kind`),
    auth: string(auth[name], `connector_auth.${name}`),
    auth_mode: mode,
    scopes: strings(source.scopes, `${path}.scopes`),
    tool_refs: strings(source.tool_refs, `${path}.tool_refs`).map(translateRef),
    metadata: record(source.metadata === undefined ? {} : source.metadata, `${path}.metadata`),
  };
}

function grant(value: unknown, path: string): WorkspaceAgentToolPermission {
  const source = fields(value, path, ['ref', 'scopes', 'connector', 'approval', 'metadata']);
  const approval = fields(
    source.approval === undefined ? {} : source.approval,
    `${path}.approval`,
    ['mode', 'reason', 'metadata'],
  );
  return {
    ref: translateRef(string(source.ref, `${path}.ref`)),
    scopes: source.scopes === undefined ? ['read'] : strings(source.scopes, `${path}.scopes`),
    connector: optionalString(source.connector, `${path}.connector`),
    approval: {
      mode: approval.mode === undefined ? 'policy' : string(approval.mode, `${path}.approval.mode`),
      reason: optionalString(approval.reason, `${path}.approval.reason`, true),
      metadata: record(
        approval.metadata === undefined ? {} : approval.metadata,
        `${path}.approval.metadata`,
      ),
    },
    metadata: record(source.metadata === undefined ? {} : source.metadata, `${path}.metadata`),
  };
}

function hostedTool(value: unknown, path: string): HostedToolSpec {
  const source = fields(value, path, ['type', 'name', 'config']);
  return {
    type: string(source.type, `${path}.type`),
    ...(source.name == null ? {} : { name: string(source.name, `${path}.name`) }),
    ...(source.config === undefined ? {} : { config: record(source.config, `${path}.config`) }),
  };
}

function modelRef(value: unknown, providerValue: unknown): string {
  const model = string(value, 'model');
  const provider = optionalString(providerValue, 'model_provider');
  if (provider !== undefined && (provider.includes(':') || provider.includes('/'))) {
    invalid('model_provider', 'must be a provider id');
  }
  const parsed = parseProviderModelRef(model, provider);
  if (provider !== undefined && parsed.provider !== provider) {
    invalid('model', 'conflicts with model_provider');
  }
  return `${parsed.provider}:${parsed.model}`;
}

function translateRef(ref: string): string {
  if (ref.startsWith('workspace:')) {
    const operation = WORKSPACE_OPERATIONS.get(ref.slice('workspace:'.length));
    if (operation === undefined) unsupported(ref, 'workspace operation has no native equivalent');
    return `workspace:${operation}`;
  }
  if (ref.startsWith('local:')) return `local:${translateToolName(ref.slice('local:'.length))}`;
  return translateToolName(ref);
}

function translateToolName(name: string): string {
  if (!name.startsWith('workspace_')) return name;
  const suffix = name.slice('workspace_'.length);
  const operation = WORKSPACE_OPERATIONS.get(suffix);
  if (operation !== undefined) return `workspace_${operation}`;
  if (['delete_file', 'apply_patch', 'snapshot', 'expose_port'].includes(suffix)) {
    unsupported(name, 'default workspace tool has no native equivalent');
  }
  return name;
}

function fields(
  value: unknown,
  path: string,
  allowed: readonly string[],
): Readonly<Record<string, unknown>> {
  const result = record(value, path);
  for (const key of Object.keys(result))
    if (!allowed.includes(key)) invalid(`${path}.${key}`, 'unrecognized field');
  return result;
}
function record(value: unknown, path: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    invalid(path, 'must be an object');
  return value as Readonly<Record<string, unknown>>;
}
function array(value: unknown, path: string): readonly unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) invalid(path, 'must be an array');
  return value;
}
function strings(value: unknown, path: string): readonly string[] {
  return array(value, path).map((item) => string(item, path));
}
function string(value: unknown, path: string, empty = false): string {
  if (typeof value !== 'string' || (!empty && (!value.trim() || value !== value.trim())))
    invalid(path, 'must be a string');
  return value;
}
function optionalString(value: unknown, path: string, empty = false): string | undefined {
  return value == null ? undefined : string(value, path, empty);
}
function invalid(path: string, message: string): never {
  throw new ConfigurationError(`Python workspace-agent package ${path}: ${message}.`);
}
function unsupported(path: string, message: string): never {
  throw new AgentRuntimeError(`Python workspace-agent package ${path}: ${message}.`, {
    code: 'unsupported_agent_package',
  });
}

function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new AgentRuntimeError('Python package text must be UTF-8.', {
      code: 'malformed_agent_package',
      cause,
    });
  }
}
