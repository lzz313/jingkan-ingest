import { afterEach, describe, expect, it, vi } from 'vitest';
import { backfillTranslations } from '../src/ingest/backfill';

interface PendingItem {
  id: string;
  needsTitle: boolean;
  needsBody: boolean;
}

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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('translation backfill', () => {
  it('translates titles and bodies, then stops when the queue drains', async () => {
    const batches: PendingItem[][] = [
      [
        { id: 'hn:1', needsTitle: true, needsBody: true },
        { id: 'hn:2', needsTitle: true, needsBody: false },
      ],
      [],
    ];
    const translateCalls: Array<{ ids: string[]; field: string }> = [];
    let adminCalls = 0;

    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      if (url.includes('/api/admin/untranslated')) {
        return json({ items: batches[adminCalls++] ?? [] });
      }
      if (url.endsWith('/api/translate')) {
        const body = JSON.parse(String(init?.body)) as { ids: string[]; field: string };
        translateCalls.push(body);
        return json({
          translations: Object.fromEntries(body.ids.map((id) => [id, `译-${id}`])),
        });
      }
      return new Response('not found', { status: 404 });
    });

    const result = await backfillTranslations(CONFIG, { now: () => 0 });
    expect(adminCalls).toBe(2);
    expect(result).toEqual({ rounds: 1, translated: 3, remaining: 0 });
    expect(translateCalls).toEqual([
      { ids: ['hn:1', 'hn:2'], field: 'title' },
      { ids: ['hn:1'], field: 'body' },
    ]);
  });

  it('keeps title progress when body translation fails, stopping after two empty rounds', async () => {
    const bodyCalls: string[][] = [];
    let adminCalls = 0;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      if (url.includes('/api/admin/untranslated')) {
        adminCalls++;
        return json({
          items: [
            { id: 'hn:1', needsTitle: adminCalls === 1, needsBody: true },
          ],
        });
      }
      if (url.endsWith('/api/translate')) {
        const body = JSON.parse(String(init?.body)) as { ids: string[]; field: string };
        if (body.field === 'body') {
          bodyCalls.push(body.ids);
          return new Response('upstream failed', { status: 500 });
        }
        return json({ translations: { 'hn:1': '标题译文' } });
      }
      return new Response('not found', { status: 404 });
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await backfillTranslations(CONFIG, { now: () => 0 });
    // Body fails every round; title succeeds once and the loop gives up after
    // two consecutive rounds with nothing translated.
    expect(result.rounds).toBe(3);
    expect(result.translated).toBe(1);
    expect(bodyCalls).toHaveLength(3);
    expect(log.mock.calls.some((call) => String(call[0]).includes('without progress'))).toBe(true);
  });

  it('stops at maxRounds when items keep coming back', async () => {
    let adminCalls = 0;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      if (url.includes('/api/admin/untranslated')) {
        adminCalls++;
        return json({ items: [{ id: 'hn:1', needsTitle: true, needsBody: false }] });
      }
      const body = JSON.parse(String(init?.body)) as { ids: string[] };
      return json({ translations: Object.fromEntries(body.ids.map((id) => [id, '译'])) });
    });

    const result = await backfillTranslations(CONFIG, { maxRounds: 2, now: () => 0 });
    expect(adminCalls).toBe(2);
    expect(result.rounds).toBe(2);
  });

  it('stops when the wall-clock budget is exhausted', async () => {
    let clock = 0;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await backfillTranslations(CONFIG, {
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

  it('does nothing when translation prewarm is disabled', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await backfillTranslations(
      { ...CONFIG, prewarmTranslations: false },
      { now: () => 0 },
    );
    expect(result).toEqual({ rounds: 0, translated: 0, remaining: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects when the admin endpoint is unauthorized', async () => {
    vi.stubGlobal('fetch', async () => new Response('unauthorized', { status: 401 }));
    await expect(backfillTranslations(CONFIG, { now: () => 0 })).rejects.toThrow(
      'Admin untranslated failed',
    );
  });
});
