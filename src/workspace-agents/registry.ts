import { AgentRuntimeError } from '../core/errors.js';
import type { SQLiteDatabase } from '../persistence/sqlite.js';
import type { WorkspaceAgentSpec } from './types.js';
import { assertValidWorkspaceAgent } from './validation.js';

export interface PublishedWorkspaceAgent {
  readonly spec: WorkspaceAgentSpec;
  readonly published_at: string;
  readonly deprecated_at?: string;
}

export interface WorkspaceAgentRegistry {
  publish(spec: WorkspaceAgentSpec): void | Promise<void>;
  get(
    id: string,
    version?: string,
  ): PublishedWorkspaceAgent | undefined | Promise<PublishedWorkspaceAgent | undefined>;
  list(options?: {
    readonly visibility?: WorkspaceAgentSpec['visibility'];
    readonly include_deprecated?: boolean;
  }): readonly PublishedWorkspaceAgent[] | Promise<readonly PublishedWorkspaceAgent[]>;
  deprecate(id: string, version: string): void | Promise<void>;
}

export class InMemoryWorkspaceAgentRegistry implements WorkspaceAgentRegistry {
  private readonly records = new Map<string, PublishedWorkspaceAgent>();
  constructor(private readonly now = () => new Date()) {}
  publish(spec: WorkspaceAgentSpec): void {
    assertValidWorkspaceAgent(spec);
    const key = versionKey(spec.id, spec.version);
    if (this.records.has(key))
      throw new AgentRuntimeError(`Workspace agent '${key}' is already published.`, {
        code: 'agent_version_exists',
      });
    this.records.set(key, { spec: structuredClone(spec), published_at: this.now().toISOString() });
  }
  get(id: string, version?: string): PublishedWorkspaceAgent | undefined {
    const matches = [...this.records.values()].filter(
      (record) =>
        record.spec.id === id && (version === undefined || record.spec.version === version),
    );
    return structuredClone(
      matches.sort((left, right) => right.spec.version.localeCompare(left.spec.version))[0],
    );
  }
  list(
    options: {
      readonly visibility?: WorkspaceAgentSpec['visibility'];
      readonly include_deprecated?: boolean;
    } = {},
  ): readonly PublishedWorkspaceAgent[] {
    return [...this.records.values()]
      .filter(
        (record) =>
          (options.visibility === undefined || record.spec.visibility === options.visibility) &&
          (options.include_deprecated === true || record.deprecated_at === undefined),
      )
      .map((record) => structuredClone(record));
  }
  deprecate(id: string, version: string): void {
    const key = versionKey(id, version);
    const record = this.records.get(key);
    if (record === undefined)
      throw new AgentRuntimeError(`Workspace agent '${key}' was not found.`, {
        code: 'agent_version_not_found',
      });
    this.records.set(key, { ...record, deprecated_at: this.now().toISOString() });
  }
}

export class SQLiteWorkspaceAgentRegistry implements WorkspaceAgentRegistry {
  constructor(
    private readonly database: SQLiteDatabase,
    private readonly now = () => new Date(),
  ) {
    database.exec(
      'CREATE TABLE IF NOT EXISTS blackbox_workspace_agents (agent_id TEXT NOT NULL, version TEXT NOT NULL, visibility TEXT NOT NULL, deprecated_at TEXT, body TEXT NOT NULL, PRIMARY KEY(agent_id, version))',
    );
  }
  publish(spec: WorkspaceAgentSpec): void {
    assertValidWorkspaceAgent(spec);
    if (this.get(spec.id, spec.version) !== undefined)
      throw new AgentRuntimeError(
        `Workspace agent '${versionKey(spec.id, spec.version)}' is already published.`,
        { code: 'agent_version_exists' },
      );
    const record = { spec, published_at: this.now().toISOString() };
    this.database
      .prepare(
        'INSERT INTO blackbox_workspace_agents (agent_id, version, visibility, deprecated_at, body) VALUES (?, ?, ?, ?, ?)',
      )
      .run(spec.id, spec.version, spec.visibility, null, JSON.stringify(record));
  }
  get(id: string, version?: string): PublishedWorkspaceAgent | undefined {
    const records = this.list({ include_deprecated: true }).filter(
      (record) =>
        record.spec.id === id && (version === undefined || record.spec.version === version),
    );
    return records.sort((left, right) => right.spec.version.localeCompare(left.spec.version))[0];
  }
  list(
    options: {
      readonly visibility?: WorkspaceAgentSpec['visibility'];
      readonly include_deprecated?: boolean;
    } = {},
  ): readonly PublishedWorkspaceAgent[] {
    return this.database
      .prepare('SELECT body FROM blackbox_workspace_agents ORDER BY agent_id, version')
      .all()
      .map(readRecord)
      .filter(
        (record) =>
          (options.visibility === undefined || record.spec.visibility === options.visibility) &&
          (options.include_deprecated === true || record.deprecated_at === undefined),
      );
  }
  deprecate(id: string, version: string): void {
    const record = this.get(id, version);
    if (record === undefined)
      throw new AgentRuntimeError(`Workspace agent '${versionKey(id, version)}' was not found.`, {
        code: 'agent_version_not_found',
      });
    const next = { ...record, deprecated_at: this.now().toISOString() };
    this.database
      .prepare(
        'UPDATE blackbox_workspace_agents SET deprecated_at = ?, body = ? WHERE agent_id = ? AND version = ?',
      )
      .run(next.deprecated_at, JSON.stringify(next), id, version);
  }
}

function versionKey(id: string, version: string): string {
  return `${id}@${version}`;
}
function readRecord(row: unknown): PublishedWorkspaceAgent {
  if (typeof row !== 'object' || row === null || !('body' in row) || typeof row.body !== 'string')
    throw new TypeError('Workspace-agent SQLite row has no body.');
  return JSON.parse(row.body) as PublishedWorkspaceAgent;
}
