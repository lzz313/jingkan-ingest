import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchText } from '../src/ingest/fetch';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchWithRetry', () => {
  it('sends caller-provided headers and keeps defaults for the rest', async () => {
    let seen: Headers | undefined;
    vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen = new Headers(init?.headers);
      return new Response('ok');
    });

    await fetchText('https://example.com/latest.rss', {
      headers: {
        accept: 'application/rss+xml',
        'x-return-format': 'html',
      },
    });

    expect(seen?.get('accept')).toBe('application/rss+xml');
    expect(seen?.get('x-return-format')).toBe('html');
    expect(seen?.get('user-agent')).toBeTruthy();
  });

  it('does not retry permanent 4xx responses', async () => {
    for (const status of [403, 404]) {
      const calls = vi.fn(async () => new Response('denied', { status, statusText: 'Denied' }));
      vi.stubGlobal('fetch', calls);

      await expect(fetchText('https://example.com/missing', { retries: 2 })).rejects.toThrow(`HTTP ${status}`);
      // A 403/404 will not change on a retry; it must fail after one attempt
      // instead of sleeping through the whole retry budget.
      expect(calls).toHaveBeenCalledTimes(1);
    }
  });

  it('still retries rate limits and server errors', async () => {
    for (const status of [429, 503]) {
      let calls = 0;
      vi.stubGlobal('fetch', async () => {
        calls++;
        return calls === 1
          ? new Response('later', { status, statusText: 'Later' })
          : new Response('ok');
      });

      await expect(fetchText('https://example.com/flaky')).resolves.toBe('ok');
      expect(calls).toBe(2);
    }
  });
});
