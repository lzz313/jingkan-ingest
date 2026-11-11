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
});
