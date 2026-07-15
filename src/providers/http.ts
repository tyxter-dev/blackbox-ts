import { ProviderExecutionError } from '../core/errors.js';

export interface FetchJsonResult {
  readonly json: unknown;
  readonly text: string;
}

export interface SSEMessage {
  readonly event?: string;
  readonly data: string;
  readonly id?: string;
  readonly retry?: number;
  readonly raw: string;
}

export interface FetchRetryOptions {
  readonly max_retries?: number;
  readonly base_delay_ms?: number;
  readonly max_delay_ms?: number;
  readonly retry_statuses?: readonly number[];
  readonly sleep?: (milliseconds: number) => Promise<void>;
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

export async function throwResponseError(provider: string, response: Response): Promise<never> {
  const body = await readSafeErrorBody(response);
  throw new ProviderExecutionError(provider, response.status, body, undefined, {
    request_id:
      response.headers.get('x-request-id') ?? response.headers.get('request-id') ?? undefined,
    retry_after_ms: parseRetryAfter(response.headers.get('retry-after')),
  });
}

export async function readSafeErrorBody(response: Response, maxBytes = 65_536): Promise<unknown> {
  const text = (await response.text()).slice(0, maxBytes);
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export async function* decodeSSE(
  response: Response,
  signal?: AbortSignal,
): AsyncIterable<SSEMessage> {
  if (response.body === null) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const abort = () => {
    void reader.cancel(signal?.reason).catch(() => undefined);
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      if (signal?.aborted === true) throw abortError(signal.reason);
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const normalized = buffer.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
      const boundary = normalized.lastIndexOf('\n\n');
      if (boundary >= 0) {
        const complete = normalized.slice(0, boundary);
        buffer = normalized.slice(boundary + 2);
        for (const block of complete.split('\n\n')) {
          const message = parseSSEBlock(block);
          if (message !== undefined) yield message;
        }
      } else {
        buffer = normalized;
      }
      if (done) break;
    }
    const finalMessage = parseSSEBlock(buffer.trim());
    if (finalMessage !== undefined) yield finalMessage;
  } finally {
    signal?.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}

export function parseSSEJson(message: SSEMessage): unknown {
  if (message.data === '[DONE]') return undefined;
  try {
    return JSON.parse(message.data) as unknown;
  } catch (cause) {
    throw new ProviderExecutionError('sse', 502, message.data, cause);
  }
}

export async function fetchWithRetry(
  fetchImpl: typeof fetch,
  input: URL | RequestInfo,
  init: RequestInit,
  options: FetchRetryOptions = {},
): Promise<Response> {
  const maxRetries = options.max_retries ?? 2;
  const retryStatuses = new Set(options.retry_statuses ?? [408, 409, 425, 429, 500, 502, 503, 504]);
  const sleep =
    options.sleep ??
    ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  let attempt = 0;
  while (true) {
    try {
      const response = await fetchImpl(input, init);
      if (!retryStatuses.has(response.status) || attempt >= maxRetries) return response;
      const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
      await sleep(retryAfter ?? retryDelay(attempt, options));
    } catch (cause) {
      if (attempt >= maxRetries || init.signal?.aborted === true) throw cause;
      await sleep(retryDelay(attempt, options));
    }
    attempt += 1;
  }
}

export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

export function timeoutSignal(
  timeoutMs?: number,
  parentSignal?: AbortSignal,
): {
  readonly signal?: AbortSignal;
  cancel(): void;
} {
  if ((!timeoutMs || timeoutMs <= 0) && parentSignal === undefined) {
    return { cancel() {} };
  }

  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parentSignal?.reason);
  parentSignal?.addEventListener('abort', abortFromParent, { once: true });
  if (parentSignal?.aborted === true) abortFromParent();
  const timer =
    timeoutMs !== undefined && timeoutMs > 0
      ? setTimeout(() => controller.abort('provider timeout'), timeoutMs)
      : undefined;
  return {
    signal: controller.signal,
    cancel() {
      if (timer !== undefined) clearTimeout(timer);
      parentSignal?.removeEventListener('abort', abortFromParent);
    },
  };
}

function parseSSEBlock(block: string): SSEMessage | undefined {
  if (!block || block.startsWith(':')) return undefined;
  const data: string[] = [];
  let event: string | undefined;
  let id: string | undefined;
  let retry: number | undefined;
  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? '' : line.slice(separator + 1).replace(/^ /, '');
    if (field === 'data') data.push(value);
    else if (field === 'event') event = value;
    else if (field === 'id') id = value;
    else if (field === 'retry' && /^\d+$/.test(value)) retry = Number(value);
  }
  if (data.length === 0) return undefined;
  return { event, data: data.join('\n'), id, retry, raw: block };
}

function retryDelay(attempt: number, options: FetchRetryOptions): number {
  const base = options.base_delay_ms ?? 250;
  const maximum = options.max_delay_ms ?? 5_000;
  return Math.min(maximum, base * 2 ** attempt);
}

function abortError(reason: unknown): Error {
  const error = new Error('The provider stream was aborted.', { cause: reason });
  error.name = 'AbortError';
  return error;
}
