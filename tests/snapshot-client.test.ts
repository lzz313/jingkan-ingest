import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSnapshot } from '../src/ingest/snapshot';
import { collectSnapshot, runSnapshot, SnapshotDeferred } from '../src/ingest/snapshot-client';
import type { FeedItem } from '../src/shared/types';

const config = { baseUrl: 'https://jing.show', ingestToken: 'test', prewarmTranslations: false };
const post = (id: string): FeedItem => ({
  id, source: 'x', externalId: id, storyKey: null, title: id, titleZh: null,
  body: 'content', brief: null, briefZh: null, bodyZh: null, url: 'https://x.com/a/status/' + id,
  author: null, authorHandle: null, publishedAt: Date.now(), fetchedAt: Date.now(), firstSeenAt: Date.now(),
  metrics: {}, hotScore: 1, isHot: false, images: [], extra: {}, hidden: false, contentHash: id,
});
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
afterEach(() => vi.unstubAllGlobals());

function mockServer(nextVersion: number, acceptUploads = false) {
  const baseItems = [post('x:1'), post('x:2')];
  const meta = { dataVersion: 1, lastUpdated: 1, lastRefreshAt: 0, sources: {}, syncRevision: 1 };
  const base = buildSnapshot(baseItems, meta);
  const paths: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (request: string | URL, init?: RequestInit) => {
    const url = new URL(request);
    paths.push((init?.method ?? 'GET') + ' ' + url.pathname + url.search);
    if (url.pathname.endsWith('/sync-meta')) return json({ meta: { ...meta, dataVersion: nextVersion }, sources: {}, retentionDays: 35, rowsReadToday: 10 });
    if (url.pathname.endsWith('/base')) return json(base.manifest);
    if (url.pathname.endsWith('/artifact') && init?.method !== 'PUT') {
      const artifact = base.artifacts[Number(url.searchParams.get('part') ?? 0)]!;
      return new Response(new Uint8Array(artifact.body));
    }
    if (url.pathname.endsWith('/sync')) return json({ items: [post('x:3')], removed: [{ id: 'x:1', publishedAt: Date.now() }], rowsRead: 2, nextCursor: null });
    if (init?.method === 'PUT') return acceptUploads ? json({ ok: true }) : json({ error: 'upload failed' }, 503);
    if (init?.method === 'POST' && url.pathname.endsWith('/activate') && acceptUploads) return json({ ok: true });
    throw new Error('Unexpected request: ' + url.pathname);
  }));
  return paths;
}

describe('incremental snapshot generation', () => {
  it('reuses R2 items without exporting D1 rows when the watermark has not changed', async () => {
    const paths = mockServer(1);
    const result = await collectSnapshot(config);
    expect(result.items.map((item) => item.id).sort()).toEqual(['x:1', 'x:2']);
    expect(paths.some((path) => path.includes('/sync?'))).toBe(false);
    expect(result.meta.syncRevision).toBe(1);
  });
  it('merges incremental updates and explicit visibility removals', async () => {
    const paths = mockServer(2);
    const result = await collectSnapshot(config);
    expect(result.items.map((item) => item.id).sort()).toEqual(['x:2', 'x:3']);
    expect(result.meta.removed).toHaveProperty('x:1');
    expect(paths.find((path) => path.includes('/sync?'))).toContain('since=1&until=2');
  });
  it('never activates a snapshot after an upload failure', async () => {
    const paths = mockServer(1);
    await expect(runSnapshot(config)).rejects.toThrow('upload failed');
    expect(paths.some((path) => path.includes('/activate'))).toBe(false);
  });
  it('stops before any base download when the server has paused export', async () => {
    const fetcher = vi.fn(async () => json({ retryAt: Date.now() + 10000 }, 429));
    vi.stubGlobal('fetch', fetcher);
    await expect(collectSnapshot(config)).rejects.toBeInstanceOf(SnapshotDeferred);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('can migrate an existing R2 snapshot without using D1 or changing source timestamps', async () => {
    const paths = mockServer(1, true);
    await runSnapshot(config, { repackOnly: true });
    expect(paths.some((path) => path.includes('/sync'))).toBe(false);
    expect(paths.some((path) => path.includes('/activate'))).toBe(true);
  });

});
