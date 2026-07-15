import type { ApprovalDecision, ApprovalRequest } from '../core/approvals.js';
import type { ArtifactRef } from '../core/artifacts.js';
import { SessionCursorError, SessionNotFoundError } from '../core/errors.js';
import type { AgentEvent } from '../core/events.js';
import type { AgentSession, InvocationRef } from '../core/sessions.js';
import type { ProviderState, RunState } from '../core/state.js';

export interface EventQuery {
  readonly run_id?: string;
  readonly session_id?: string;
  readonly after_event_id?: string;
  readonly limit?: number;
}

export interface EventStore {
  append(event: AgentEvent): void | Promise<void>;
  list(query?: EventQuery): readonly AgentEvent[] | Promise<readonly AgentEvent[]>;
}

export interface RunStore {
  save(state: RunState): void | Promise<void>;
  load(sessionId: string): RunState | undefined | Promise<RunState | undefined>;
  all(): readonly RunState[] | Promise<readonly RunState[]>;
}

export interface SessionSnapshot {
  readonly session: AgentSession;
  readonly events: readonly AgentEvent[];
  readonly invocations: readonly InvocationRef[];
  readonly approvals: Readonly<
    Record<string, { readonly request: ApprovalRequest; readonly decision?: ApprovalDecision }>
  >;
  readonly provider_state?: ProviderState;
  readonly workspace_state: Readonly<Record<string, unknown>>;
  readonly mcp_state: Readonly<Record<string, unknown>>;
  readonly artifacts: readonly ArtifactRef[];
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface SessionStore {
  save(snapshot: SessionSnapshot): void | Promise<void>;
  load(sessionId: string): SessionSnapshot | undefined | Promise<SessionSnapshot | undefined>;
  list(): readonly SessionSnapshot[] | Promise<readonly SessionSnapshot[]>;
  appendEvent(sessionId: string, event: AgentEvent): void | Promise<void>;
}

export interface ProviderCacheEntry<T = unknown> {
  readonly key: string;
  readonly provider: string;
  readonly value: T;
  readonly created_at: string;
  readonly expires_at?: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface ProviderCacheStore {
  get<T = unknown>(
    key: string,
  ): ProviderCacheEntry<T> | undefined | Promise<ProviderCacheEntry<T> | undefined>;
  set<T = unknown>(entry: ProviderCacheEntry<T>): void | Promise<void>;
  delete(key: string): boolean | Promise<boolean>;
  clear(provider?: string): number | Promise<number>;
}

export type PersistenceClock = () => Date;

export class InMemoryEventStore implements EventStore {
  private readonly events: AgentEvent[] = [];

  append(event: AgentEvent): void {
    this.events.push(event);
  }

  list(query: EventQuery = {}): readonly AgentEvent[] {
    let events = this.events.filter(
      (event) =>
        (query.run_id === undefined || event.run_id === query.run_id) &&
        (query.session_id === undefined || event.session_id === query.session_id),
    );
    if (query.after_event_id !== undefined) {
      const index = events.findIndex((event) => event.id === query.after_event_id);
      if (index < 0) {
        throw new SessionCursorError(`Unknown event cursor '${query.after_event_id}'.`, {
          operation: 'event_store.list',
        });
      }
      events = events.slice(index + 1);
    }
    return query.limit === undefined ? [...events] : events.slice(0, query.limit);
  }
}

export class InMemoryRunStore implements RunStore {
  private readonly states = new Map<string, RunState>();

  save(state: RunState): void {
    this.states.set(state.session_id, structuredClone(state));
  }

  load(sessionId: string): RunState | undefined {
    const state = this.states.get(sessionId);
    return state === undefined ? undefined : structuredClone(state);
  }

  all(): readonly RunState[] {
    return [...this.states.values()].map((state) => structuredClone(state));
  }
}

export class InMemorySessionStore implements SessionStore {
  private readonly snapshots = new Map<string, SessionSnapshot>();

  save(snapshot: SessionSnapshot): void {
    this.snapshots.set(snapshot.session.id, structuredClone(snapshot));
  }

  load(sessionId: string): SessionSnapshot | undefined {
    const snapshot = this.snapshots.get(sessionId);
    return snapshot === undefined ? undefined : structuredClone(snapshot);
  }

  list(): readonly SessionSnapshot[] {
    return [...this.snapshots.values()].map((snapshot) => structuredClone(snapshot));
  }

  appendEvent(sessionId: string, event: AgentEvent): void {
    const snapshot = this.snapshots.get(sessionId);
    if (snapshot === undefined) {
      throw new SessionNotFoundError(`Session '${sessionId}' was not found.`, {
        session_id: sessionId,
        operation: 'session_store.append_event',
      });
    }
    this.snapshots.set(sessionId, {
      ...snapshot,
      events: [...snapshot.events, structuredClone(event)],
    });
  }
}

export class InMemoryProviderCacheStore implements ProviderCacheStore {
  private readonly entries = new Map<string, ProviderCacheEntry>();

  constructor(private readonly clock: PersistenceClock = () => new Date()) {}

  get<T = unknown>(key: string): ProviderCacheEntry<T> | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expires_at !== undefined && Date.parse(entry.expires_at) <= this.clock().getTime()) {
      this.entries.delete(key);
      return undefined;
    }
    return structuredClone(entry) as ProviderCacheEntry<T>;
  }

  set<T = unknown>(entry: ProviderCacheEntry<T>): void {
    this.entries.set(entry.key, structuredClone(entry));
  }

  delete(key: string): boolean {
    return this.entries.delete(key);
  }

  clear(provider?: string): number {
    if (provider === undefined) {
      const count = this.entries.size;
      this.entries.clear();
      return count;
    }
    let count = 0;
    for (const [key, entry] of this.entries) {
      if (entry.provider === provider && this.entries.delete(key)) count += 1;
    }
    return count;
  }
}

export function createProviderCacheEntry<T>(
  key: string,
  provider: string,
  value: T,
  options: {
    readonly ttl_ms?: number;
    readonly created_at?: Date;
    readonly metadata?: Readonly<Record<string, unknown>>;
  } = {},
): ProviderCacheEntry<T> {
  const createdAt = options.created_at ?? new Date();
  return {
    key,
    provider,
    value,
    created_at: createdAt.toISOString(),
    expires_at:
      options.ttl_ms === undefined
        ? undefined
        : new Date(createdAt.getTime() + options.ttl_ms).toISOString(),
    metadata: options.metadata ?? {},
  };
}

export function createSessionSnapshot(
  session: AgentSession,
  input: Partial<Omit<SessionSnapshot, 'session'>> = {},
): SessionSnapshot {
  return {
    session,
    events: input.events ?? [],
    invocations: input.invocations ?? [],
    approvals: input.approvals ?? {},
    provider_state: input.provider_state,
    workspace_state: input.workspace_state ?? {},
    mcp_state: input.mcp_state ?? {},
    artifacts: input.artifacts ?? [],
    metadata: input.metadata ?? {},
  };
}
