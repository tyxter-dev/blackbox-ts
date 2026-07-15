import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { AgentRuntimeError } from '../core/errors.js';
import type { AgentEvent } from '../core/events.js';
import { deserializeDurable, serializeDurable } from '../core/serialization.js';
import type { EventQuery, EventStore, SessionSnapshot, SessionStore } from './stores.js';
import { InMemoryEventStore, InMemorySessionStore } from './stores.js';

export class JSONLEventStore implements EventStore {
  private writeChain = Promise.resolve();

  constructor(readonly path: string) {}

  append(event: AgentEvent): Promise<void> {
    this.writeChain = this.writeChain.then(() =>
      appendLine(this.path, serializeDurable('event', event)),
    );
    return this.writeChain;
  }

  async list(query: EventQuery = {}): Promise<readonly AgentEvent[]> {
    await this.writeChain;
    const store = new InMemoryEventStore();
    for (const event of await readLines<AgentEvent>(this.path, 'event')) store.append(event);
    return store.list(query);
  }
}

export class JSONLSessionStore implements SessionStore {
  private writeChain = Promise.resolve();

  constructor(readonly path: string) {}

  save(snapshot: SessionSnapshot): Promise<void> {
    this.writeChain = this.writeChain.then(() =>
      appendLine(this.path, serializeDurable('session_snapshot', snapshot)),
    );
    return this.writeChain;
  }

  async load(sessionId: string): Promise<SessionSnapshot | undefined> {
    const snapshots = await this.list();
    return snapshots.find((snapshot) => snapshot.session.id === sessionId);
  }

  async list(): Promise<readonly SessionSnapshot[]> {
    await this.writeChain;
    const latest = new Map<string, SessionSnapshot>();
    for (const snapshot of await readLines<SessionSnapshot>(this.path, 'session_snapshot')) {
      latest.set(snapshot.session.id, snapshot);
    }
    return [...latest.values()];
  }

  async appendEvent(sessionId: string, event: AgentEvent): Promise<void> {
    const memory = new InMemorySessionStore();
    for (const snapshot of await this.list()) memory.save(snapshot);
    memory.appendEvent(sessionId, event);
    const updated = memory.load(sessionId);
    if (updated !== undefined) await this.save(updated);
  }
}

async function appendLine(path: string, line: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${line}\n`, 'utf8');
}

async function readLines<T>(path: string, kind: string): Promise<readonly T[]> {
  let content: string;
  try {
    content = await readFile(path, 'utf8');
  } catch (cause) {
    if (isNotFound(cause)) return [];
    throw cause;
  }

  const result: T[] = [];
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      result.push(deserializeDurable<T>(line, kind));
    } catch (cause) {
      throw new AgentRuntimeError(`Corrupt JSONL record at ${path}:${index + 1}.`, {
        code: 'corrupt_jsonl_record',
        cause,
      });
    }
  }
  return result;
}

function isNotFound(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'code' in value && value.code === 'ENOENT';
}
