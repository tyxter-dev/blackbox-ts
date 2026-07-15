import { inspect } from 'node:util';
import { AgentRuntimeError, WorkItemNotFoundError, WorkSourceError } from '../core/errors.js';
import { allow, type Policy } from '../core/policy.js';

export type WorkItemStatus = 'pending' | 'leased' | 'completed' | 'failed';

export interface WorkItem<T = unknown> {
  readonly id: string;
  readonly payload: T;
  readonly status: WorkItemStatus;
  readonly attempts: number;
  readonly lease_id?: string;
  readonly lease_expires_at?: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface WorkResult<T = unknown> {
  readonly output?: T;
  readonly error?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface WorkSourceStats {
  readonly pending: number;
  readonly leased: number;
  readonly completed: number;
  readonly failed: number;
  readonly reclaimed: number;
}

export interface WorkSource<T = unknown> {
  readonly id: string;
  claim(options?: {
    readonly lease_ms?: number;
    readonly worker_id?: string;
  }): WorkItem<T> | undefined | Promise<WorkItem<T> | undefined>;
  heartbeat(itemId: string, leaseId: string, leaseMs?: number): boolean | Promise<boolean>;
  complete(itemId: string, leaseId: string, result: WorkResult): void | Promise<void>;
  fail(itemId: string, leaseId: string, result: WorkResult): void | Promise<void>;
  stats(): WorkSourceStats | Promise<WorkSourceStats>;
  stop(): void | Promise<void>;
}

export class WorkerCredentials {
  readonly scopes: readonly string[];
  readonly expires_at?: string;
  #secret: string;

  constructor(
    secret: string,
    options: { readonly scopes?: readonly string[]; readonly expires_at?: string } = {},
  ) {
    this.#secret = secret;
    this.scopes = options.scopes ?? [];
    this.expires_at = options.expires_at;
  }
  reveal(): string {
    return this.#secret;
  }
  toJSON(): Readonly<Record<string, unknown>> {
    return { secret: '<redacted>', scopes: this.scopes, expires_at: this.expires_at };
  }
  toString(): string {
    return 'WorkerCredentials(<redacted>)';
  }
  [inspect.custom](): string {
    return this.toString();
  }
}

interface MutableWorkItem<T> {
  id: string;
  payload: T;
  status: WorkItemStatus;
  attempts: number;
  lease_id?: string;
  lease_expires_at?: string;
  metadata: Readonly<Record<string, unknown>>;
  result?: WorkResult;
}

export class InMemoryWorkSource<T = unknown> implements WorkSource<T> {
  readonly id: string;
  private readonly items = new Map<string, MutableWorkItem<T>>();
  private stopped = false;
  private reclaimed = 0;
  private sequence = 0;

  constructor(
    items: readonly {
      readonly id: string;
      readonly payload: T;
      readonly metadata?: Readonly<Record<string, unknown>>;
    }[] = [],
    private readonly now = () => new Date(),
    id = 'memory',
  ) {
    this.id = id;
    for (const item of items) this.enqueue(item.id, item.payload, item.metadata);
  }

  enqueue(id: string, payload: T, metadata: Readonly<Record<string, unknown>> = {}): void {
    if (this.items.has(id))
      throw new WorkSourceError(`Work item '${id}' already exists.`, { code: 'work_item_exists' });
    this.items.set(id, { id, payload, status: 'pending', attempts: 0, metadata });
  }

  claim(
    options: { readonly lease_ms?: number; readonly worker_id?: string } = {},
  ): WorkItem<T> | undefined {
    if (this.stopped) return undefined;
    this.reclaimExpired();
    const item = [...this.items.values()].find((candidate) => candidate.status === 'pending');
    if (item === undefined) return undefined;
    const leaseId = `${options.worker_id ?? 'worker'}:${++this.sequence}`;
    item.status = 'leased';
    item.attempts += 1;
    item.lease_id = leaseId;
    item.lease_expires_at = new Date(
      this.now().getTime() + (options.lease_ms ?? 30_000),
    ).toISOString();
    return cloneItem(item);
  }

  heartbeat(itemId: string, leaseId: string, leaseMs = 30_000): boolean {
    const item = this.requireLeased(itemId, leaseId);
    if (Date.parse(item.lease_expires_at ?? '') <= this.now().getTime()) return false;
    item.lease_expires_at = new Date(this.now().getTime() + leaseMs).toISOString();
    return true;
  }

  complete(itemId: string, leaseId: string, result: WorkResult): void {
    this.finish(itemId, leaseId, 'completed', result);
  }

  fail(itemId: string, leaseId: string, result: WorkResult): void {
    this.finish(itemId, leaseId, 'failed', result);
  }

  stats(): WorkSourceStats {
    this.reclaimExpired();
    const count = (status: WorkItemStatus) =>
      [...this.items.values()].filter((item) => item.status === status).length;
    return {
      pending: count('pending'),
      leased: count('leased'),
      completed: count('completed'),
      failed: count('failed'),
      reclaimed: this.reclaimed,
    };
  }

  stop(): void {
    this.stopped = true;
  }

  private reclaimExpired(): void {
    const now = this.now().getTime();
    for (const item of this.items.values()) {
      if (item.status === 'leased' && Date.parse(item.lease_expires_at ?? '') <= now) {
        item.status = 'pending';
        item.lease_id = undefined;
        item.lease_expires_at = undefined;
        this.reclaimed += 1;
      }
    }
  }

  private finish(
    itemId: string,
    leaseId: string,
    status: 'completed' | 'failed',
    result: WorkResult,
  ): void {
    const item = this.requireLeased(itemId, leaseId);
    if (Date.parse(item.lease_expires_at ?? '') <= this.now().getTime())
      throw new WorkSourceError(`Lease for work item '${itemId}' was lost.`, {
        code: 'work_lease_lost',
      });
    item.status = status;
    item.result = result;
    item.lease_id = undefined;
    item.lease_expires_at = undefined;
  }

  private requireLeased(itemId: string, leaseId: string): MutableWorkItem<T> {
    const item = this.items.get(itemId);
    if (item === undefined) throw new WorkItemNotFoundError(`Work item '${itemId}' was not found.`);
    if (item.status !== 'leased' || item.lease_id !== leaseId)
      throw new WorkSourceError(`Work item '${itemId}' is not held by lease '${leaseId}'.`, {
        code: 'work_lease_mismatch',
      });
    return item;
  }
}

export interface EnvironmentWorkerStats {
  readonly claimed: number;
  readonly completed: number;
  readonly failed: number;
  readonly lost_leases: number;
  readonly running: boolean;
  readonly stopped: boolean;
}

export interface WorkHandlerContext {
  readonly signal: AbortSignal;
  readonly credentials?: WorkerCredentials;
  heartbeat(leaseMs?: number): Promise<boolean>;
}

export class EnvironmentWorker<T = unknown> {
  private readonly abort = new AbortController();
  private claimed = 0;
  private completed = 0;
  private failed = 0;
  private lostLeases = 0;
  private running = false;
  private stopped = false;

  constructor(
    readonly source: WorkSource<T>,
    private readonly handler: (item: WorkItem<T>, context: WorkHandlerContext) => unknown,
    private readonly options: {
      readonly worker_id?: string;
      readonly lease_ms?: number;
      readonly policy?: Policy;
      readonly credentials?: WorkerCredentials;
    } = {},
  ) {}

  async drain(): Promise<EnvironmentWorkerStats> {
    this.running = true;
    try {
      while (!this.stopped) {
        const policy =
          (await this.options.policy?.check({
            checkpoint: 'before_work_claim',
            action: this.source.id,
            arguments: {},
            metadata: {},
          })) ?? allow();
        if (policy.verdict !== 'allow') break;
        const item = await this.source.claim({
          lease_ms: this.options.lease_ms,
          worker_id: this.options.worker_id,
        });
        if (item === undefined) break;
        this.claimed += 1;
        const leaseId = item.lease_id!;
        try {
          const output = await this.handler(item, {
            signal: this.abort.signal,
            credentials: this.options.credentials,
            heartbeat: async (leaseMs) => this.source.heartbeat(item.id, leaseId, leaseMs),
          });
          await this.source.complete(item.id, leaseId, { output });
          this.completed += 1;
        } catch (cause) {
          if (cause instanceof WorkSourceError && cause.code === 'work_lease_lost')
            this.lostLeases += 1;
          else {
            await this.source.fail(item.id, leaseId, {
              error: cause instanceof Error ? cause.message : 'Worker handler failed.',
            });
            this.failed += 1;
          }
        }
      }
    } finally {
      this.running = false;
    }
    return this.status();
  }

  run(): Promise<EnvironmentWorkerStats> {
    return this.drain();
  }
  async stop(options: { readonly force?: boolean } = {}): Promise<void> {
    this.stopped = true;
    if (options.force === true) this.abort.abort(new Error('Worker forced to stop.'));
    await this.source.stop();
  }
  status(): EnvironmentWorkerStats {
    return {
      claimed: this.claimed,
      completed: this.completed,
      failed: this.failed,
      lost_leases: this.lostLeases,
      running: this.running,
      stopped: this.stopped,
    };
  }
}

export interface AnthropicEnvironmentClient<T> {
  claim(options: {
    readonly lease_ms?: number;
    readonly worker_id?: string;
  }): Promise<WorkItem<T> | undefined>;
  heartbeat(itemId: string, leaseId: string, leaseMs?: number): Promise<boolean>;
  complete(itemId: string, leaseId: string, result: WorkResult): Promise<void>;
  fail(itemId: string, leaseId: string, result: WorkResult): Promise<void>;
  stats(): Promise<WorkSourceStats>;
  stop(): Promise<void>;
}

export class AnthropicEnvironmentWorkSource<T> implements WorkSource<T> {
  readonly id = 'anthropic-managed-agents';
  constructor(
    private readonly client: AnthropicEnvironmentClient<T>,
    options: { readonly acknowledge_live_beta?: boolean } = {},
  ) {
    if (options.acknowledge_live_beta !== true)
      throw new AgentRuntimeError(
        'Anthropic Managed Agents is partial/beta; acknowledge_live_beta is required.',
        { code: 'live_beta_acknowledgement_required' },
      );
  }
  claim = (options?: { readonly lease_ms?: number; readonly worker_id?: string }) =>
    this.client.claim(options ?? {});
  heartbeat = (itemId: string, leaseId: string, leaseMs?: number) =>
    this.client.heartbeat(itemId, leaseId, leaseMs);
  complete = (itemId: string, leaseId: string, result: WorkResult) =>
    this.client.complete(itemId, leaseId, result);
  fail = (itemId: string, leaseId: string, result: WorkResult) =>
    this.client.fail(itemId, leaseId, result);
  stats = () => this.client.stats();
  stop = () => this.client.stop();
}

function cloneItem<T>(item: MutableWorkItem<T>): WorkItem<T> {
  return structuredClone(item);
}
