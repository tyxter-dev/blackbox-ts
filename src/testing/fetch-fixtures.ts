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

export function createJsonFetchFixture(
  responseBody: unknown,
  options: { readonly status?: number; readonly headers?: Readonly<Record<string, string>> } = {},
): JsonFetchFixture {
  const calls: CapturedFetchCall[] = [];
  const fetchImpl: typeof fetch = async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
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
