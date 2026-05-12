import { ProviderExecutionError } from '../core/errors.js';

export interface FetchJsonResult {
  readonly json: unknown;
  readonly text: string;
}

export function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

export async function readJson(response: Response): Promise<FetchJsonResult> {
  const text = await response.text();
  if (text.length === 0) return { json: {}, text };
  try {
    return { json: JSON.parse(text) as unknown, text };
  } catch {
    return { json: text, text };
  }
}

export function throwProviderError(provider: string, status: number, responseBody: unknown): never {
  throw new ProviderExecutionError(provider, status, responseBody);
}

export function timeoutSignal(timeoutMs?: number): { readonly signal?: AbortSignal; cancel(): void } {
  if (!timeoutMs || timeoutMs <= 0) {
    return { cancel() {} };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    cancel() {
      clearTimeout(timer);
    },
  };
}
