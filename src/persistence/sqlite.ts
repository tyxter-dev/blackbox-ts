import type { AgentEvent } from '../core/events.js';
import type { RunState } from '../core/state.js';
import { deserializeDurable, serializeDurable } from '../core/serialization.js';
import type {
  EventQuery,
  EventStore,
  ProviderCacheEntry,
  ProviderCacheStore,
  RunStore,
  SessionSnapshot,
  SessionStore,
} from './stores.js';
import { InMemoryEventStore } from './stores.js';

export interface SQLiteStatement {
  run(...parameters: readonly unknown[]): unknown;
  get(...parameters: readonly unknown[]): unknown;
  all(...parameters: readonly unknown[]): readonly unknown[];
}

export interface SQLiteDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): SQLiteStatement;
}

export class SQLiteEventStore implements EventStore {
  constructor(private readonly database: SQLiteDatabase) {
    database.exec(
      'CREATE TABLE IF NOT EXISTS blackbox_events (ordinal INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, body TEXT NOT NULL)',
    );
  }

  append(event: AgentEvent): void {
    this.database
      .prepare('INSERT INTO blackbox_events (id, body) VALUES (?, ?)')
      .run(event.id, serializeDurable('event', event));
  }

  list(query: EventQuery = {}): readonly AgentEvent[] {
    const rows = this.database
      .prepare('SELECT body FROM blackbox_events ORDER BY ordinal ASC')
      .all();
    const memory = new InMemoryEventStore();
    for (const row of rows) memory.append(readBody<AgentEvent>(row, 'event'));
    return memory.list(query);
  }
}

export class SQLiteRunStore implements RunStore {
  constructor(private readonly database: SQLiteDatabase) {
    database.exec(
      'CREATE TABLE IF NOT EXISTS blackbox_runs (session_id TEXT PRIMARY KEY, body TEXT NOT NULL)',
    );
  }

  save(state: RunState): void {
    this.database
      .prepare(
        'INSERT INTO blackbox_runs (session_id, body) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET body=excluded.body',
      )
      .run(state.session_id, serializeDurable('run_state', state));
  }

  load(sessionId: string): RunState | undefined {
    const row = this.database
      .prepare('SELECT body FROM blackbox_runs WHERE session_id = ?')
      .get(sessionId);
    return row === undefined ? undefined : readBody<RunState>(row, 'run_state');
  }

  all(): readonly RunState[] {
    return this.database
      .prepare('SELECT body FROM blackbox_runs ORDER BY session_id ASC')
      .all()
      .map((row) => readBody<RunState>(row, 'run_state'));
  }
}

export class SQLiteSessionStore implements SessionStore {
  constructor(private readonly database: SQLiteDatabase) {
    database.exec(
      'CREATE TABLE IF NOT EXISTS blackbox_sessions (session_id TEXT PRIMARY KEY, body TEXT NOT NULL)',
    );
  }

  save(snapshot: SessionSnapshot): void {
    this.database
      .prepare(
        'INSERT INTO blackbox_sessions (session_id, body) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET body=excluded.body',
      )
      .run(snapshot.session.id, serializeDurable('session_snapshot', snapshot));
  }

  load(sessionId: string): SessionSnapshot | undefined {
    const row = this.database
      .prepare('SELECT body FROM blackbox_sessions WHERE session_id = ?')
      .get(sessionId);
    return row === undefined ? undefined : readBody<SessionSnapshot>(row, 'session_snapshot');
  }

  list(): readonly SessionSnapshot[] {
    return this.database
      .prepare('SELECT body FROM blackbox_sessions ORDER BY session_id ASC')
      .all()
      .map((row) => readBody<SessionSnapshot>(row, 'session_snapshot'));
  }

  appendEvent(sessionId: string, event: AgentEvent): void {
    const snapshot = this.load(sessionId);
    if (snapshot === undefined) throw new Error(`Session '${sessionId}' was not found.`);
    this.save({ ...snapshot, events: [...snapshot.events, event] });
  }
}

export class SQLiteProviderCacheStore implements ProviderCacheStore {
  constructor(
    private readonly database: SQLiteDatabase,
    private readonly now = () => new Date(),
  ) {
    database.exec(
      'CREATE TABLE IF NOT EXISTS blackbox_provider_cache (cache_key TEXT PRIMARY KEY, provider TEXT NOT NULL, expires_at TEXT, body TEXT NOT NULL)',
    );
  }

  get<T = unknown>(key: string): ProviderCacheEntry<T> | undefined {
    const row = this.database
      .prepare('SELECT body FROM blackbox_provider_cache WHERE cache_key = ?')
      .get(key);
    if (row === undefined) return undefined;
    const entry = readBody<ProviderCacheEntry<T>>(row, 'provider_cache_entry');
    if (entry.expires_at !== undefined && Date.parse(entry.expires_at) <= this.now().getTime()) {
      this.delete(key);
      return undefined;
    }
    return entry;
  }

  set<T = unknown>(entry: ProviderCacheEntry<T>): void {
    this.database
      .prepare(
        'INSERT INTO blackbox_provider_cache (cache_key, provider, expires_at, body) VALUES (?, ?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET provider=excluded.provider, expires_at=excluded.expires_at, body=excluded.body',
      )
      .run(
        entry.key,
        entry.provider,
        entry.expires_at,
        serializeDurable('provider_cache_entry', entry),
      );
  }

  delete(key: string): boolean {
    const existing = this.getWithoutExpiry(key);
    this.database.prepare('DELETE FROM blackbox_provider_cache WHERE cache_key = ?').run(key);
    return existing !== undefined;
  }

  clear(provider?: string): number {
    const rows = this.database
      .prepare('SELECT body FROM blackbox_provider_cache ORDER BY cache_key ASC')
      .all()
      .map((row) => readBody<ProviderCacheEntry>(row, 'provider_cache_entry'));
    const keys = rows
      .filter((entry) => provider === undefined || entry.provider === provider)
      .map((entry) => entry.key);
    for (const key of keys) this.delete(key);
    return keys.length;
  }

  private getWithoutExpiry(key: string): ProviderCacheEntry | undefined {
    const row = this.database
      .prepare('SELECT body FROM blackbox_provider_cache WHERE cache_key = ?')
      .get(key);
    return row === undefined
      ? undefined
      : readBody<ProviderCacheEntry>(row, 'provider_cache_entry');
  }
}

function readBody<T>(row: unknown, kind: string): T {
  if (typeof row !== 'object' || row === null || !('body' in row) || typeof row.body !== 'string') {
    throw new TypeError(`SQLite ${kind} row does not contain a string body.`);
  }
  return deserializeDurable<T>(row.body, kind);
}
