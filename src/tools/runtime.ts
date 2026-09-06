import { ToolExecutionError } from '../core/errors.js';
import {
  activePermissions,
  approvalKey,
  approvedPackageCall,
  internalDiscoveryTool,
  packageDecision,
  toolRequest,
} from '../core/tool-permissions.js';
import {
  isToolResult,
  toolResult,
  type ToolCallOptions,
  type ToolDefinition,
  type ToolHandlerContext,
  type ToolHandlerOutput,
  type ToolResult,
} from './types.js';
import { ToolRegistry } from './registry.js';

export interface ToolRuntimeOptions {
  readonly timeout_ms?: number;
  readonly max_concurrency?: number;
  readonly context?: Readonly<Record<string, unknown>>;
  readonly blocking_executor?: BlockingToolExecutor;
  readonly signal?: AbortSignal;
  readonly package_approvals?: ReadonlySet<string>;
}

export interface BlockingToolExecutor {
  execute(
    definition: ToolDefinition,
    arguments_: Readonly<Record<string, unknown>>,
    context: ToolHandlerContext,
  ): ToolHandlerOutput | Promise<ToolHandlerOutput>;
}

export class ToolRuntime {
  private readonly timeoutMs: number;
  private readonly context: Readonly<Record<string, unknown>>;
  private readonly semaphore: Semaphore;
  private readonly blockingExecutor?: BlockingToolExecutor;
  private readonly signal?: AbortSignal;

  /**
   * Approval keys ({@link approvalKey}) already granted for this run. A grant
   * that requires approval only dispatches while its key is present here.
   */
  package_approvals: ReadonlySet<string>;

  constructor(
    readonly registry: ToolRegistry,
    options: ToolRuntimeOptions = {},
  ) {
    this.timeoutMs = options.timeout_ms ?? 30_000;
    this.context = options.context ?? {};
    this.semaphore = new Semaphore(options.max_concurrency ?? 8);
    this.blockingExecutor = options.blocking_executor;
    this.signal = options.signal;
    this.package_approvals = options.package_approvals ?? new Set();
  }

  async call(
    name: string,
    arguments_: Readonly<Record<string, unknown>>,
    options: ToolCallOptions = {},
  ): Promise<ToolResult> {
    const release = await this.semaphore.acquire(this.signal, name);
    try {
      const registered = this.registry.get(name);
      // Nothing constrains this call: keep the pre-package dispatch path exactly
      // as it was, with no descriptor copy, policy request, or approval key.
      const enforced = activePermissions().length > 0 || this.package_approvals.size > 0;
      // Copy the registered entry at dispatch: the permission decision and the
      // execution below must describe the same tool even if the registry entry
      // is edited while this call is in flight.
      const definition = enforced ? dispatchCopy(registered) : registered;
      if (enforced && !internalDiscoveryTool(definition)) {
        const decision = packageDecision(
          toolRequest(definition, { checkpoint: 'before_tool_call', arguments: arguments_ }),
        );
        if (
          decision.verdict === 'deny' ||
          (decision.verdict === 'require_approval' &&
            !this.package_approvals.has(approvalKey(definition)))
        ) {
          return toolResult(decision.reason ?? 'Package permission denied.', {
            is_error: true,
            payload: { error: 'denied_by_policy', reason: decision.reason },
            metadata: {
              error: 'denied_by_policy',
              tool: name,
              checkpoint: 'before_tool_call',
              reason: decision.reason,
            },
          });
        }
      }
      if (options.mock === true) {
        return toolResult(`[mock:${name}]`, {
          payload: { tool: name, arguments: arguments_ },
          metadata: { mock: true },
        });
      }
      const handler = definition.handler;
      if (handler === undefined) {
        throw new ToolExecutionError(`Tool '${name}' has no local handler.`, {
          code: 'tool_handler_missing',
        });
      }
      // An approval already granted for this exact call travels with the
      // dispatch so a nested checkpoint (consumed by A6/A7) does not ask for it
      // a second time.
      const approvedRequest =
        enforced && this.package_approvals.has(approvalKey(definition))
          ? toolRequest(definition)
          : undefined;
      return await approvedPackageCall(approvedRequest, async () => {
        const controller = new AbortController();
        const timeoutMs = options.timeout_ms ?? this.timeoutMs;
        const cancel = () => controller.abort(this.signal?.reason ?? new Error('Tool cancelled.'));
        if (this.signal?.aborted === true) cancel();
        else this.signal?.addEventListener('abort', cancel, { once: true });
        const timeout = setTimeout(
          () =>
            controller.abort(
              new ToolExecutionError(`Tool '${name}' timed out after ${timeoutMs}ms.`, {
                code: 'tool_timeout',
              }),
            ),
          timeoutMs,
        );
        try {
          const context = { ...this.context, ...options.context };
          const injected = injectContext(arguments_, definition.context_parameters ?? [], context);
          const handlerContext = { signal: controller.signal, values: context };
          const pending =
            definition.blocking === true
              ? this.executeBlocking(definition, injected, handlerContext)
              : Promise.resolve(handler(injected, handlerContext));
          const value = await raceAbort(pending, controller.signal, name, timeoutMs);
          return coerceToolResult(value);
        } catch (cause) {
          if (cause instanceof ToolExecutionError) throw cause;
          throw new ToolExecutionError(`Tool '${name}' failed.`, {
            code: 'tool_execution_failed',
            cause,
          });
        } finally {
          clearTimeout(timeout);
          this.signal?.removeEventListener('abort', cancel);
        }
      });
    } finally {
      release();
    }
  }

  private executeBlocking(
    definition: ToolDefinition,
    arguments_: Readonly<Record<string, unknown>>,
    context: ToolHandlerContext,
  ): Promise<ToolHandlerOutput> {
    if (this.blockingExecutor !== undefined) {
      return Promise.resolve(this.blockingExecutor.execute(definition, arguments_, context));
    }
    // Arbitrary closures cannot be transferred to a worker without an application-level
    // registry. The default defers invocation; a worker/process executor can be injected.
    return new Promise((resolve, reject) => {
      setImmediate(() => {
        try {
          if (definition.handler === undefined) throw new Error('Missing tool handler.');
          resolve(definition.handler(arguments_, context));
        } catch (cause) {
          reject(cause instanceof Error ? cause : new Error('Blocking tool failed.'));
        }
      });
    });
  }
}

/**
 * Snapshot one registered definition for the duration of a dispatch.
 *
 * Every declared field is read explicitly rather than spread: a definition may
 * be a class instance whose fields (a `handler` getter, say) live on the
 * prototype, which an own-property spread would silently drop.
 */
function dispatchCopy(definition: ToolDefinition): ToolDefinition {
  return {
    name: definition.name,
    description: definition.description,
    input_schema: definition.input_schema,
    handler: definition.handler,
    category: definition.category,
    tags: definition.tags === undefined ? undefined : [...definition.tags],
    risk: definition.risk,
    scopes: definition.scopes === undefined ? undefined : [...definition.scopes],
    latency: definition.latency,
    cost: definition.cost,
    side_effects: definition.side_effects,
    examples: definition.examples === undefined ? undefined : [...definition.examples],
    negative_examples:
      definition.negative_examples === undefined ? undefined : [...definition.negative_examples],
    context_parameters:
      definition.context_parameters === undefined ? undefined : [...definition.context_parameters],
    blocking: definition.blocking,
    metadata: definition.metadata === undefined ? undefined : { ...definition.metadata },
  };
}

export function coerceToolResult(value: unknown): ToolResult {
  if (isToolResult(value)) return value;
  if (typeof value === 'string') return toolResult(value);
  if (value === undefined) return toolResult('');
  if (typeof value === 'object') return toolResult(JSON.stringify(value), { payload: value });
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return toolResult(`${value}`, { payload: value });
  }
  throw new ToolExecutionError('Tool returned an unsupported value.', {
    code: 'unsupported_tool_result',
  });
}

function injectContext(
  arguments_: Readonly<Record<string, unknown>>,
  names: readonly string[],
  context: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const result: Record<string, unknown> = { ...arguments_ };
  for (const name of names) {
    if (!(name in context)) {
      throw new ToolExecutionError(`Tool context value '${name}' is not available.`, {
        code: 'tool_context_missing',
      });
    }
    result[name] = context[name];
  }
  return result;
}

async function raceAbort<T>(
  pending: Promise<T>,
  signal: AbortSignal,
  name: string,
  timeoutMs: number,
): Promise<T> {
  if (signal.aborted) throw toolAbort(signal.reason, name, timeoutMs);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(toolAbort(signal.reason, name, timeoutMs));
    signal.addEventListener('abort', abort, { once: true });
    void pending.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (cause: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      },
    );
  });
}

function toolAbort(reason: unknown, name: string, timeoutMs: number): Error {
  if (reason instanceof ToolExecutionError) return reason;
  return new ToolExecutionError(`Tool '${name}' was cancelled.`, {
    code: 'tool_cancelled',
    cause: reason ?? { timeout_ms: timeoutMs },
  });
}

class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError('Tool max concurrency must be a positive integer.');
    }
  }

  async acquire(signal?: AbortSignal, toolName = 'unknown'): Promise<() => void> {
    if (signal?.aborted === true) throw toolAbort(signal.reason, toolName, 0);
    if (this.active >= this.capacity) {
      await new Promise<void>((resolve, reject) => {
        const waiter = () => {
          signal?.removeEventListener('abort', abort);
          resolve();
        };
        const abort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(toolAbort(signal?.reason, toolName, 0));
        };
        this.waiters.push(waiter);
        signal?.addEventListener('abort', abort, { once: true });
      });
    }
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.waiters.shift()?.();
    };
  }
}
