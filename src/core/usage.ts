export interface TokenUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly total_tokens: number;
  readonly provider_details?: Readonly<Record<string, unknown>>;
}

export function tokenUsage(inputTokens = 0, outputTokens = 0, providerDetails?: Readonly<Record<string, unknown>>): TokenUsage {
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
    provider_details: providerDetails,
  };
}

export function usageFromOpenAI(value: unknown): TokenUsage {
  const usage = isRecord(value) ? value : {};
  return tokenUsage(readNumber(usage, 'prompt_tokens'), readNumber(usage, 'completion_tokens'), usage);
}

export function usageFromAnthropic(value: unknown): TokenUsage {
  const usage = isRecord(value) ? value : {};
  return tokenUsage(readNumber(usage, 'input_tokens'), readNumber(usage, 'output_tokens'), usage);
}

export function usageFromGemini(value: unknown): TokenUsage {
  const usage = isRecord(value) ? value : {};
  return tokenUsage(readNumber(usage, 'promptTokenCount'), readNumber(usage, 'candidatesTokenCount'), usage);
}

function readNumber(obj: Readonly<Record<string, unknown>>, key: string): number {
  const value = obj[key];
  return typeof value === 'number' ? value : 0;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
