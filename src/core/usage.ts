export interface ModelUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly total_tokens: number;
  readonly cached_input_tokens: number;
  readonly cache_read_input_tokens: number;
  readonly cache_creation_input_tokens: number;
  readonly reasoning_tokens: number;
  readonly tool_calls: number;
  readonly provider_details: Readonly<Record<string, unknown>>;
}

export type TokenUsage = ModelUsage;

export type ModelUsageInput = Partial<Omit<ModelUsage, 'provider_details'>> & {
  readonly provider_details?: Readonly<Record<string, unknown>>;
};

export function modelUsage(input: ModelUsageInput = {}): ModelUsage {
  const cacheRead = input.cache_read_input_tokens ?? 0;
  const cacheCreation = input.cache_creation_input_tokens ?? 0;
  const inputTokens = input.input_tokens ?? 0;
  const outputTokens = input.output_tokens ?? 0;

  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: input.total_tokens ?? inputTokens + outputTokens,
    cached_input_tokens: input.cached_input_tokens ?? cacheRead + cacheCreation,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheCreation,
    reasoning_tokens: input.reasoning_tokens ?? 0,
    tool_calls: input.tool_calls ?? 0,
    provider_details: input.provider_details ?? {},
  };
}

export function tokenUsage(
  inputTokens = 0,
  outputTokens = 0,
  providerDetails?: Readonly<Record<string, unknown>>,
): TokenUsage {
  return modelUsage({
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    provider_details: providerDetails,
  });
}

export function addUsage(left?: ModelUsage, right?: ModelUsage): ModelUsage | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;

  return modelUsage({
    input_tokens: left.input_tokens + right.input_tokens,
    output_tokens: left.output_tokens + right.output_tokens,
    total_tokens: left.total_tokens + right.total_tokens,
    cached_input_tokens: left.cached_input_tokens + right.cached_input_tokens,
    cache_read_input_tokens: left.cache_read_input_tokens + right.cache_read_input_tokens,
    cache_creation_input_tokens:
      left.cache_creation_input_tokens + right.cache_creation_input_tokens,
    reasoning_tokens: left.reasoning_tokens + right.reasoning_tokens,
    tool_calls: left.tool_calls + right.tool_calls,
    provider_details: mergeProviderDetails(left.provider_details, right.provider_details),
  });
}

export function usageFromOpenAI(value: unknown): TokenUsage {
  const usage = isRecord(value) ? value : {};
  const inputDetails = childRecord(usage, 'input_tokens_details');
  const outputDetails = childRecord(usage, 'output_tokens_details');
  const cached = readNumber(inputDetails, 'cached_tokens') || readNumber(usage, 'cached_tokens');

  return modelUsage({
    input_tokens: readNumber(usage, 'input_tokens') || readNumber(usage, 'prompt_tokens'),
    output_tokens: readNumber(usage, 'output_tokens') || readNumber(usage, 'completion_tokens'),
    total_tokens: readNumber(usage, 'total_tokens') || undefined,
    cached_input_tokens: cached,
    cache_read_input_tokens: cached,
    reasoning_tokens: readNumber(outputDetails, 'reasoning_tokens'),
    provider_details: usage,
  });
}

export function usageFromAnthropic(value: unknown): TokenUsage {
  const usage = isRecord(value) ? value : {};
  const cacheRead = readNumber(usage, 'cache_read_input_tokens');
  const cacheCreation = readNumber(usage, 'cache_creation_input_tokens');

  return modelUsage({
    input_tokens: readNumber(usage, 'input_tokens'),
    output_tokens: readNumber(usage, 'output_tokens'),
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheCreation,
    provider_details: usage,
  });
}

export function usageFromGemini(value: unknown): TokenUsage {
  const usage = isRecord(value) ? value : {};
  const cached =
    readNumber(usage, 'cachedContentTokenCount') || readNumber(usage, 'cached_content_token_count');

  return modelUsage({
    input_tokens: readNumber(usage, 'promptTokenCount') || readNumber(usage, 'prompt_token_count'),
    output_tokens:
      readNumber(usage, 'candidatesTokenCount') || readNumber(usage, 'candidates_token_count'),
    total_tokens:
      readNumber(usage, 'totalTokenCount') || readNumber(usage, 'total_token_count') || undefined,
    cached_input_tokens: cached,
    cache_read_input_tokens: cached,
    reasoning_tokens:
      readNumber(usage, 'thoughtsTokenCount') || readNumber(usage, 'thoughts_token_count'),
    provider_details: usage,
  });
}

function mergeProviderDetails(
  left: Readonly<Record<string, unknown>>,
  right: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (Object.keys(left).length === 0) return right;
  if (Object.keys(right).length === 0) return left;
  return { turns: [...detailTurns(left), ...detailTurns(right)] };
}

function detailTurns(value: Readonly<Record<string, unknown>>): readonly unknown[] {
  return Array.isArray(value.turns) ? value.turns : [value];
}

function childRecord(
  value: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<Record<string, unknown>> {
  const child = value[key];
  return isRecord(child) ? child : {};
}

function readNumber(obj: Readonly<Record<string, unknown>>, key: string): number {
  const value = obj[key];
  return typeof value === 'number' ? value : 0;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
