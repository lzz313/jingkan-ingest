import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { buildDailyDigests, publishDailyDigests } from '../src/ingest/daily';
import { isDailyDigest } from '../src/shared/daily';
import { SOURCE_IDS, type FeedItem, type SourceId } from '../src/shared/types';

const now = Date.parse('2026-11-13T12:00:00Z');
function item(source: SourceId, i = 0, publishedAt = now): FeedItem {
  return { id: `${source}:${i}`, source, externalId: String(i), storyKey: null,
    title: 'Useful research', titleZh: '有用的研究', body: 'Body', bodyZh: null, brief: 'Summary', briefZh: '中文摘要',
    url: `https://example.com/${source}/${i}`, author: 'Author', authorHandle: null, publishedAt, fetchedAt: now, firstSeenAt: now,
    metrics: {}, hotScore: i, isHot: i > 1, images: [], extra: {}, hidden: false, contentHash: 'hash' };
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it('balances sources, caps excerpts and output size, and excludes hidden records', () => {
  const items = SOURCE_IDS.flatMap((source) => Array.from({ length: 10 }, (_, i) => item(source, i)));
  items.push({ ...item('hn', 100), hidden: true });
  items[0]!.briefZh = '长'.repeat(2000);
  const [digest] = buildDailyDigests(items, now);
  expect(digest!.total).toBe(110);
  expect(digest!.entries).toHaveLength(12);
  expect(new Set(digest!.entries.map((entry) => entry.source)).size).toBe(11);
  for (const source of SOURCE_IDS) expect(digest!.entries.filter((entry) => entry.source === source).length).toBeLessThanOrEqual(2);
  expect(digest!.entries.every((entry) => entry.summary.length <= 221)).toBe(true);
  expect(isDailyDigest(digest)).toBe(true);
  expect(buildDailyDigests([...items].reverse(), now)).toEqual([digest]);
});

it('uses Beijing calendar days and preserves repository and product names', () => {
  const items = [item('hn', 1, Date.parse('2026-11-12T15:59:59Z')), item('hn', 2, Date.parse('2026-11-12T16:00:00Z')),
    { ...item('github'), title: 'owner/repository', titleZh: '错误翻译' }, { ...item('producthunt'), title: 'Product', titleZh: '错误翻译' }];
  const digests = buildDailyDigests(items, now);
  expect(digests.map((digest) => digest.day)).toEqual(['2026-11-12', '2026-11-13']);
  expect(digests[0]!.total).toBe(1);
  expect(digests[1]!.entries.find((entry) => entry.source === 'github')!.title).toBe('owner/repository');
  expect(digests[1]!.entries.find((entry) => entry.source === 'producthunt')!.title).toBe('Product');
});

it('skips unchanged and completed archives and fences changed writes to the new snapshot', async () => {
  vi.useFakeTimers(); vi.setSystemTime(now);
  const items = [item('hn'), item('hn', 1, now - 3 * 86400000), item('hn', 2, now - 86400000)];
  const digests = buildDailyDigests(items, now);
  const todayBody = JSON.stringify(digests.find((digest) => digest.day === '2026-11-13'));
  const writes: Array<{ path: string; headers: Headers }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: URL, init?: RequestInit) => {
    if (!init?.method) return new Response(JSON.stringify({ hashes: {
      '2026-11-13': createHash('sha256').update(todayBody).digest('hex'), '2026-11-10': 'completed-archive',
    } }));
    writes.push({ path: url.pathname, headers: new Headers(init.headers) });
    return new Response('{}');
  }));
  expect(await publishDailyDigests({ baseUrl: 'https://jing.show', ingestToken: 'test', prewarmTranslations: false }, items, 'lease-token', 'new-snapshot')).toBe(1);
  expect(writes[0]!.path).toBe('/api/admin/daily/2026-11-12');
  expect(writes[0]!.headers.get('x-publisher-lease')).toBe('lease-token');
  expect(writes[0]!.headers.get('x-expected-snapshot')).toBe('new-snapshot');
});
