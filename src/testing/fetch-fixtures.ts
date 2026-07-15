export interface CapturedFetchCall {
  readonly url: string;
  readonly init?: RequestInit;
  readonly body?: unknown;
  readonly headers: Readonly<Record<string, string>>;
}

export interface JsonFetchFixture {
  readonly fetchImpl: typeof fetch;
  readonly calls: CapturedFetchCall[];
}

export interface SSEFetchFixture extends JsonFetchFixture {
  readonly cancelled: { value: boolean };
}

export function createJsonFetchFixture(
  responseBody: unknown,
  options: { readonly status?: number; readonly headers?: Readonly<Record<string, string>> } = {},
): JsonFetchFixture {
  const calls: CapturedFetchCall[] = [];
  const fetchImpl: typeof fetch = async (input: URL | RequestInfo, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({
      url,
      init,
      body: typeof init?.body === 'string' ? safeJsonParse(init.body) : init?.body,
      headers: normalizeHeaders(init?.headers),
    });
    return new Response(JSON.stringify(responseBody), {
      status: options.status ?? 200,
      headers: {
        'content-type': 'application/json',
        ...(options.headers ?? {}),
      },
    });
  };
  return { fetchImpl, calls };
}

export function createSSEFetchFixture(
  chunks: readonly string[],
  options: { readonly status?: number; readonly headers?: Readonly<Record<string, string>> } = {},
): SSEFetchFixture {
  const calls: CapturedFetchCall[] = [];
  const cancelled = { value: false };
  const fetchImpl: typeof fetch = async (input: URL | RequestInfo, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({
      url,
      init,
      body: typeof init?.body === 'string' ? safeJsonParse(init.body) : init?.body,
      headers: normalizeHeaders(init?.headers),
    });
    let index = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[index++];
        if (chunk === undefined) controller.close();
        else controller.enqueue(new TextEncoder().encode(chunk));
      },
      cancel() {
        cancelled.value = true;
      },
    });
    return new Response(body, {
      status: options.status ?? 200,
      headers: { 'content-type': 'text/event-stream', ...(options.headers ?? {}) },
    });
  };
  return { fetchImpl, calls, cancelled };
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function normalizeHeaders(headers: HeadersInit | undefined): Readonly<Record<string, string>> {
  if (!headers) return {};
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }
  return headers;
}
