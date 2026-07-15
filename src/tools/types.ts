export type ToolRisk = 'low' | 'medium' | 'high' | 'critical' | (string & {});

export interface ToolHandlerContext {
  readonly signal: AbortSignal;
  readonly values: Readonly<Record<string, unknown>>;
}

export type ToolHandlerOutput =
  | string
  | number
  | boolean
  | bigint
  | null
  | undefined
  | Readonly<Record<string, unknown>>
  | readonly unknown[]
  | ToolResult;

export type ToolHandler = (
  arguments_: Readonly<Record<string, unknown>>,
  context: ToolHandlerContext,
) => ToolHandlerOutput | Promise<ToolHandlerOutput>;

export interface ToolDefinition {
  readonly name: string;
  readonly description?: string;
  readonly input_schema?: unknown;
  readonly handler?: ToolHandler;
  readonly category?: string;
  readonly tags?: readonly string[];
  readonly risk?: ToolRisk;
  readonly scopes?: readonly string[];
  readonly latency?: string;
  readonly cost?: string;
  readonly side_effects?: boolean;
  readonly examples?: readonly unknown[];
  readonly negative_examples?: readonly unknown[];
  readonly context_parameters?: readonly string[];
  readonly blocking?: boolean;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ProviderToolDefinition {
  readonly name: string;
  readonly description?: string;
  readonly input_schema?: unknown;
}

export interface ToolResult<TPayload = unknown> {
  readonly content: string;
  readonly payload?: TPayload;
  readonly is_error: boolean;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface ToolCallOptions {
  readonly mock?: boolean;
  readonly timeout_ms?: number;
  readonly context?: Readonly<Record<string, unknown>>;
}

export function toolResult<TPayload = unknown>(
  content: string,
  options: {
    readonly payload?: TPayload;
    readonly is_error?: boolean;
    readonly metadata?: Readonly<Record<string, unknown>>;
  } = {},
): ToolResult<TPayload> {
  return {
    content,
    payload: options.payload,
    is_error: options.is_error ?? false,
    metadata: options.metadata ?? {},
  };
}

export function isToolResult(value: unknown): value is ToolResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    'content' in value &&
    typeof value.content === 'string' &&
    'is_error' in value &&
    typeof value.is_error === 'boolean'
  );
}
