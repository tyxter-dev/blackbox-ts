import { ToolExecutionError } from '../core/errors.js';
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

  constructor(
    readonly registry: ToolRegistry,
    options: ToolRuntimeOptions = {},
  ) {
    this.timeoutMs = options.timeout_ms ?? 30_000;
    this.context = options.context ?? {};
    this.semaphore = new Semaphore(options.max_concurrency ?? 8);
    this.blockingExecutor = options.blocking_executor;
    this.signal = options.signal;
  }

  async call(
    name: string,
    arguments_: Readonly<Record<string, unknown>>,
    options: ToolCallOptions = {},
  ): Promise<ToolResult> {
    const release = await this.semaphore.acquire(this.signal, name);
    try {
      const definition = this.registry.get(name);
      if (options.mock === true) {
        return toolResult(`[mock:${name}]`, {
          payload: { tool: name, arguments: arguments_ },
          metadata: { mock: true },
        });
      }
      if (definition.handler === undefined) {
        throw new ToolExecutionError(`Tool '${name}' has no local handler.`, {
          code: 'tool_handler_missing',
        });
      }

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
            : Promise.resolve(definition.handler(injected, handlerContext));
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
