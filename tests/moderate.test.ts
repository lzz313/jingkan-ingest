import { afterEach, describe, expect, it, vi } from 'vitest';
import { moderatePosts } from '../src/ingest/moderate';

const CONFIG = {
  baseUrl: 'https://jingkan.test',
  ingestToken: 'test-token',
  prewarmTranslations: true,
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function urlOf(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
}

function stubSequence(responses: unknown[]): { calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let index = 0;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: urlOf(input), init });
    const next = responses[Math.min(index++, responses.length - 1)];
    return next instanceof Response ? next : json(next);
  });
  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.AI_MODERATION;
});

describe('moderatePosts', () => {
  it('drains the queue and stops when no rows remain', async () => {
    const { calls } = stubSequence([
      { checked: 60, hidden: 5, remaining: 60, failed: 0 },
      { checked: 60, hidden: 2, remaining: 0, failed: 0 },
    ]);

    const result = await moderatePosts(CONFIG);
    expect(calls).toHaveLength(2);
    expect(result).toEqual({ rounds: 2, checked: 120, hidden: 7, remaining: 0, failed: 0 });
  });

  it('stops after two rounds when no verdicts are written', async () => {
    const { calls } = stubSequence([
      { checked: 0, hidden: 0, remaining: 50, failed: 50 },
      { checked: 0, hidden: 0, remaining: 50, failed: 50 },
    ]);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await moderatePosts(CONFIG);
    expect(calls).toHaveLength(2);
    expect(result.rounds).toBe(2);
    expect(result.checked).toBe(0);
    expect(result.failed).toBe(100);
    expect(result.remaining).toBe(50);
  });

  it('stops after two rounds where the backlog does not shrink', async () => {
    const { calls } = stubSequence([
      { checked: 20, hidden: 0, remaining: 50, failed: 0 },
      { checked: 20, hidden: 0, remaining: 50, failed: 0 },
      { checked: 20, hidden: 0, remaining: 50, failed: 0 },
    ]);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await moderatePosts(CONFIG);
    expect(calls).toHaveLength(3);
    expect(result.rounds).toBe(3);
  });

  it('honours maxRounds', async () => {
    const { calls } = stubSequence([
      { checked: 20, hidden: 0, remaining: 40, failed: 0 },
      { checked: 20, hidden: 0, remaining: 20, failed: 0 },
      { checked: 20, hidden: 0, remaining: 0, failed: 0 },
    ]);

    const result = await moderatePosts(CONFIG, { maxRounds: 2 });
    expect(calls).toHaveLength(2);
    expect(result.rounds).toBe(2);
    expect(result.remaining).toBe(20);
  });

  it('stops when the wall-clock budget is already exhausted', async () => {
    let clock = 0;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await moderatePosts(CONFIG, {
      timeBudgetMs: 5_000,
      now: () => {
        const value = clock;
        clock += 10_000;
        return value;
      },
    });
    expect(result.rounds).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does nothing when AI_MODERATION=0', async () => {
    process.env.AI_MODERATION = '0';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await moderatePosts(CONFIG);
    expect(result).toEqual({ rounds: 0, checked: 0, hidden: 0, remaining: null, failed: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects when the admin endpoint is unauthorized', async () => {
    vi.stubGlobal('fetch', async () => new Response('unauthorized', { status: 401 }));
    await expect(moderatePosts(CONFIG)).rejects.toThrow('Moderation failed');
  });

  it('sends the ingest token and the requested batch size', async () => {
    const { calls } = stubSequence([{ checked: 10, hidden: 0, remaining: 0, failed: 0 }]);

    await moderatePosts(CONFIG, { limit: 40 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://jingkan.test/api/admin/moderate');
    expect(calls[0]?.init?.method).toBe('POST');
    expect((calls[0]?.init?.headers as Record<string, string>).authorization).toBe(
      `Bearer ${CONFIG.ingestToken}`,
    );
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ limit: 40 });
  });
});
