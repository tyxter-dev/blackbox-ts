import { describe, expect, it } from 'vitest';

import {
  createSSEFetchFixture,
  decodeSSE,
  fetchWithRetry,
  parseRetryAfter,
  parseSSEJson,
} from '../../src/index.js';

describe('provider HTTP streaming', () => {
  it('decodes arbitrarily chunked SSE fields and multiline data', async () => {
    const fixture = createSSEFetchFixture([
      ': keep-alive\r\n\r\nevent: message\r\nid: 1\r\ndata: {"a":',
      '1}\r\n\r\ndata: first\ndata: second\n\n',
    ]);
    const response = await fixture.fetchImpl('https://provider.test/stream');
    const messages = [];
    for await (const message of decodeSSE(response)) messages.push(message);

    expect(messages).toHaveLength(2);
    expect(parseSSEJson(messages[0]!)).toEqual({ a: 1 });
    expect(messages[1]).toMatchObject({ data: 'first\nsecond' });
  });

  it('retries classified statuses and honors Retry-After', async () => {
    let calls = 0;
    const delays: number[] = [];
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return calls === 1
        ? new Response('busy', { status: 503, headers: { 'retry-after': '0.01' } })
        : new Response('ok');
    };

    const response = await fetchWithRetry(
      fetchImpl,
      'https://provider.test',
      {},
      {
        sleep: (milliseconds) => {
          delays.push(milliseconds);
          return Promise.resolve();
        },
      },
    );
    expect(await response.text()).toBe('ok');
    expect(calls).toBe(2);
    expect(delays).toEqual([10]);
    expect(parseRetryAfter('2')).toBe(2_000);
  });

  it('cancels the underlying reader when aborted', async () => {
    const fixture = createSSEFetchFixture(['data: one\n\n', 'data: two\n\n']);
    const response = await fixture.fetchImpl('https://provider.test/stream');
    const controller = new AbortController();
    const iterator = decodeSSE(response, controller.signal)[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({ value: { data: 'one' } });
    controller.abort();
    await expect(iterator.next()).rejects.toMatchObject({ name: 'AbortError' });
    expect(fixture.cancelled.value).toBe(true);
  });
});
