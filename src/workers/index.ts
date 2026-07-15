import { inspect } from 'node:util';
import { AgentRuntimeError, WorkItemNotFoundError, WorkSourceError } from '../core/errors.js';
import { allow, type Policy } from '../core/policy.js';

export type WorkItemStatus = 'pending' | 'leased' | 'completed' | 'failed' | 'skipped' | 'stopped';
export type WorkResultStatus = 'completed' | 'failed' | 'skipped' | 'stopped';

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
  readonly status?: WorkResultStatus;
  readonly output?: T;
  readonly error?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface WorkSourceStats {
  readonly pending: number;
  readonly leased: number;
  readonly completed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly stopped: number;
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
  stopRequested?(itemId: string, leaseId: string): boolean | Promise<boolean>;
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
  stop_requested?: boolean;
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

  get(id: string): WorkItem<T> | undefined {
    const item = this.items.get(id);
    return item === undefined ? undefined : cloneItem(item);
  }

  requestStop(id: string): void {
    const item = this.items.get(id);
    if (item === undefined) throw new WorkItemNotFoundError(`Work item '${id}' was not found.`);
    item.stop_requested = true;
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
    this.finish(
      itemId,
      leaseId,
      result.status === 'skipped' || result.status === 'stopped' ? result.status : 'completed',
      result,
    );
  }

  fail(itemId: string, leaseId: string, result: WorkResult): void {
    this.finish(itemId, leaseId, 'failed', result);
  }

  stopRequested(itemId: string, leaseId: string): boolean {
    return this.requireLeased(itemId, leaseId).stop_requested === true;
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
      skipped: count('skipped'),
      stopped: count('stopped'),
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
    status: WorkResultStatus,
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
  readonly skipped: number;
  readonly stopped_items: number;
  readonly lost_leases: number;
  readonly handled: number;
  readonly running: boolean;
  readonly stopped: boolean;
  readonly state: 'idle' | 'handling' | 'stopped';
  readonly last_polled_at?: string;
  readonly in_flight_work_id?: string;
}

export interface WorkHandlerContext {
  readonly signal: AbortSignal;
  readonly credentials?: WorkerCredentials;
  heartbeat(leaseMs?: number): Promise<boolean>;
}

export class EnvironmentWorker<T = unknown> {
  private claimed = 0;
  private completed = 0;
  private failed = 0;
  private skipped = 0;
  private stoppedItems = 0;
  private lostLeases = 0;
  private running = false;
  private stopped = false;
  private forceStopped = false;
  private state: 'idle' | 'handling' | 'stopped' = 'idle';
  private lastPolledAt: string | undefined;
  private inFlightWorkId: string | undefined;
  private currentAbort: AbortController | undefined;
  private interruptCurrent: ((reason: 'forced_stop') => void) | undefined;
  private wakePoll: (() => void) | undefined;

  constructor(
    readonly source: WorkSource<T>,
    private readonly handler: (item: WorkItem<T>, context: WorkHandlerContext) => unknown,
    private readonly options: {
      readonly worker_id?: string;
      readonly lease_ms?: number;
      readonly heartbeat_ms?: number;
      readonly poll_interval_ms?: number;
      readonly policy?: Policy;
      readonly credentials?: WorkerCredentials;
    } = {},
  ) {
    if ((options.lease_ms ?? 30_000) <= 0)
      throw new AgentRuntimeError('Worker lease_ms must be greater than zero.', {
        code: 'invalid_worker_configuration',
      });
    if (this.heartbeatMs() <= 0)
      throw new AgentRuntimeError('Worker heartbeat_ms must be greater than zero.', {
        code: 'invalid_worker_configuration',
      });
    if ((options.poll_interval_ms ?? 1_000) < 0)
      throw new AgentRuntimeError('Worker poll_interval_ms cannot be negative.', {
        code: 'invalid_worker_configuration',
      });
  }

  async drain(): Promise<readonly WorkResult[]> {
    this.prepareToRun();
    this.running = true;
    const results: WorkResult[] = [];
    try {
      while (!this.stopped) {
        const result = await this.handleOne();
        if (result === undefined) break;
        results.push(result);
      }
    } finally {
      this.running = false;
      this.state = this.stopped ? 'stopped' : 'idle';
    }
    return results;
  }

  async run(): Promise<EnvironmentWorkerStats> {
    this.prepareToRun();
    this.running = true;
    try {
      while (!this.stopped) {
        if ((await this.handleOne()) !== undefined) continue;
        await this.waitForPoll();
      }
    } finally {
      this.running = false;
      this.state = 'stopped';
    }
    return this.status();
  }

  async handleOne(): Promise<WorkResult | undefined> {
    if (this.stopped) return undefined;
    const item = await this.source.claim({
      lease_ms: this.options.lease_ms,
      worker_id: this.options.worker_id,
    });
    this.lastPolledAt = new Date().toISOString();
    if (item === undefined) return undefined;
    if (item.lease_id === undefined)
      throw new WorkSourceError(`Claimed work item '${item.id}' did not include a lease id.`, {
        code: 'work_lease_missing',
      });

    this.claimed += 1;
    this.state = 'handling';
    this.inFlightWorkId = item.id;
    try {
      return await this.process(item, item.lease_id);
    } finally {
      this.inFlightWorkId = undefined;
      this.currentAbort = undefined;
      this.interruptCurrent = undefined;
      this.state = this.stopped ? 'stopped' : 'idle';
    }
  }

  async stop(options: { readonly force?: boolean } = {}): Promise<void> {
    this.stopped = true;
    if (options.force === true) {
      this.forceStopped = true;
      this.interruptCurrent?.('forced_stop');
    }
    this.wakePoll?.();
    await this.source.stop();
  }

  status(): EnvironmentWorkerStats {
    return {
      claimed: this.claimed,
      completed: this.completed,
      failed: this.failed,
      skipped: this.skipped,
      stopped_items: this.stoppedItems,
      lost_leases: this.lostLeases,
      handled: this.completed + this.failed + this.skipped + this.stoppedItems + this.lostLeases,
      running: this.running,
      stopped: this.stopped,
      state: this.state,
      ...(this.lastPolledAt === undefined ? {} : { last_polled_at: this.lastPolledAt }),
      ...(this.inFlightWorkId === undefined ? {} : { in_flight_work_id: this.inFlightWorkId }),
    };
  }

  private prepareToRun(): void {
    if (this.running)
      throw new AgentRuntimeError('Environment worker is already running.', {
        code: 'worker_already_running',
      });
    if (this.stopped)
      throw new AgentRuntimeError('A stopped environment worker cannot be restarted.', {
        code: 'worker_stopped',
      });
    this.state = 'idle';
  }

  private heartbeatMs(): number {
    return this.options.heartbeat_ms ?? Math.min(15_000, (this.options.lease_ms ?? 30_000) / 2);
  }

  private async process(item: WorkItem<T>, leaseId: string): Promise<WorkResult> {
    const decision =
      (await this.options.policy?.check({
        checkpoint: 'before_work_claim',
        action: item.id,
        arguments: { work_id: item.id, metadata: item.metadata },
        metadata: item.metadata,
      })) ?? allow();
    if (decision.verdict !== 'allow') {
      const result: WorkResult = {
        status: 'skipped',
        error: decision.reason ?? decision.verdict,
        metadata: { policy_verdict: decision.verdict },
      };
      try {
        await this.source.complete(item.id, leaseId, result);
        this.skipped += 1;
      } catch (cause) {
        if (isLostLease(cause)) {
          this.lostLeases += 1;
          return lostLeaseResult(cause);
        } else throw cause;
      }
      return result;
    }

    if (this.forceStopped) {
      const result: WorkResult = {
        status: 'stopped',
        error: 'Worker forced to stop.',
      };
      try {
        await this.source.complete(item.id, leaseId, result);
        this.stoppedItems += 1;
      } catch (cause) {
        if (isLostLease(cause)) {
          this.lostLeases += 1;
          return lostLeaseResult(cause);
        } else throw cause;
      }
      return result;
    }

    const controller = new AbortController();
    this.currentAbort = controller;
    let interrupt!: (reason: 'lost_lease' | 'control_stop' | 'forced_stop') => void;
    const interrupted = new Promise<'lost_lease' | 'control_stop' | 'forced_stop'>((resolve) => {
      interrupt = resolve;
    });
    this.interruptCurrent = interrupt;

    let heartbeatActive = false;
    const heartbeat = async (): Promise<void> => {
      if (heartbeatActive || controller.signal.aborted) return;
      heartbeatActive = true;
      try {
        const alive = await this.source.heartbeat(item.id, leaseId, this.options.lease_ms);
        if (!alive) {
          interrupt('lost_lease');
          return;
        }
        if (await this.source.stopRequested?.(item.id, leaseId)) interrupt('control_stop');
      } catch {
        interrupt('lost_lease');
      } finally {
        heartbeatActive = false;
      }
    };
    const timer = setInterval(() => void heartbeat(), this.heartbeatMs());

    const handler = Promise.resolve()
      .then(() =>
        this.handler(item, {
          signal: controller.signal,
          credentials: this.options.credentials,
          heartbeat: async (leaseMs) => this.source.heartbeat(item.id, leaseId, leaseMs),
        }),
      )
      .then(
        (output) => ({ kind: 'completed' as const, output }),
        (cause: unknown) => ({ kind: 'failed' as const, cause }),
      );

    const outcome = await Promise.race([
      handler,
      interrupted.then((reason) => ({ kind: 'interrupted' as const, reason })),
    ]);
    clearInterval(timer);

    if (outcome.kind === 'interrupted') {
      controller.abort(new Error(outcome.reason));
      void handler;
      if (outcome.reason === 'lost_lease') {
        this.lostLeases += 1;
        return lostLeaseResult();
      }
      const result: WorkResult = {
        status: 'stopped',
        error:
          outcome.reason === 'control_stop'
            ? 'Stop requested by control plane.'
            : 'Worker forced to stop.',
      };
      try {
        await this.source.complete(item.id, leaseId, result);
        this.stoppedItems += 1;
      } catch (cause) {
        if (isLostLease(cause)) {
          this.lostLeases += 1;
          return lostLeaseResult(cause);
        } else throw cause;
      }
      return result;
    }

    if (outcome.kind === 'failed') {
      if (isLostLease(outcome.cause)) {
        this.lostLeases += 1;
        return lostLeaseResult(outcome.cause);
      }
      const result: WorkResult = {
        status: 'failed',
        error: outcome.cause instanceof Error ? outcome.cause.message : 'Worker handler failed.',
        metadata: {
          error_type:
            outcome.cause instanceof Error ? outcome.cause.constructor.name : typeof outcome.cause,
        },
      };
      try {
        await this.source.fail(item.id, leaseId, result);
        this.failed += 1;
      } catch (cause) {
        if (isLostLease(cause)) {
          this.lostLeases += 1;
          return lostLeaseResult(cause);
        } else throw cause;
      }
      return result;
    }

    const result = normalizeHandlerResult(outcome.output);
    try {
      if (result.status === 'failed') {
        await this.source.fail(item.id, leaseId, result);
        this.failed += 1;
      } else {
        await this.source.complete(item.id, leaseId, result);
        if (result.status === 'skipped') this.skipped += 1;
        else if (result.status === 'stopped') this.stoppedItems += 1;
        else this.completed += 1;
      }
    } catch (cause) {
      if (isLostLease(cause)) {
        this.lostLeases += 1;
        return lostLeaseResult(cause);
      } else throw cause;
    }
    return result;
  }

  private async waitForPoll(): Promise<void> {
    if (this.stopped) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, this.options.poll_interval_ms ?? 1_000);
      this.wakePoll = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    this.wakePoll = undefined;
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
  stopRequested?(itemId: string, leaseId: string): Promise<boolean>;
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
  stopRequested = (itemId: string, leaseId: string) =>
    this.client.stopRequested?.(itemId, leaseId) ?? false;
  stop = () => this.client.stop();
}

function cloneItem<T>(item: MutableWorkItem<T>): WorkItem<T> {
  return structuredClone({
    id: item.id,
    payload: item.payload,
    status: item.status,
    attempts: item.attempts,
    ...(item.lease_id === undefined ? {} : { lease_id: item.lease_id }),
    ...(item.lease_expires_at === undefined ? {} : { lease_expires_at: item.lease_expires_at }),
    metadata: item.metadata,
  });
}

function isLostLease(cause: unknown): boolean {
  return (
    cause instanceof WorkSourceError &&
    (cause.code === 'work_lease_lost' || cause.code === 'work_lease_mismatch')
  );
}

function lostLeaseResult(cause?: unknown): WorkResult {
  return {
    status: 'stopped',
    error: cause instanceof Error ? cause.message : 'Work item lease was lost.',
    metadata: { lease_lost: true },
  };
}

function normalizeHandlerResult(value: unknown): WorkResult {
  if (typeof value === 'object' && value !== null && 'status' in value) {
    const status = value.status;
    if (
      status === 'completed' ||
      status === 'failed' ||
      status === 'skipped' ||
      status === 'stopped'
    ) {
      return value as WorkResult;
    }
  }
  return { status: 'completed', output: value };
}
