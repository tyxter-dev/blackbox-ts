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

  constructor(
    readonly registry: ToolRegistry,
    options: ToolRuntimeOptions = {},
  ) {
    this.timeoutMs = options.timeout_ms ?? 30_000;
    this.context = options.context ?? {};
    this.semaphore = new Semaphore(options.max_concurrency ?? 8);
    this.blockingExecutor = options.blocking_executor;
  }

  async call(
    name: string,
    arguments_: Readonly<Record<string, unknown>>,
    options: ToolCallOptions = {},
  ): Promise<ToolResult> {
    const release = await this.semaphore.acquire();
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
      const timeout = setTimeout(() => controller.abort('tool timeout'), timeoutMs);
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
  if (signal.aborted) throw toolTimeout(name, timeoutMs);
  return Promise.race([
    pending,
    new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(toolTimeout(name, timeoutMs)), { once: true });
    }),
  ]);
}

function toolTimeout(name: string, timeoutMs: number): ToolExecutionError {
  return new ToolExecutionError(`Tool '${name}' timed out after ${timeoutMs}ms.`, {
    code: 'tool_timeout',
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

  async acquire(): Promise<() => void> {
    if (this.active >= this.capacity) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
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
