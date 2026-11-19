import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { buildDailyDigests, dailyQuality, notifyIndexNow, publishDailyDigests } from '../src/ingest/daily';
import { CLUSTER_DEFAULTS, DEDUPE_DEFAULTS } from '../src/ingest/env';
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

it('ranks the day by quality, caps a source at two, and excludes hidden records', () => {
  const items = SOURCE_IDS.flatMap((source) => Array.from({ length: 10 }, (_, i) => item(source, i)));
  items.push({ ...item('hn', 100), hidden: true });
  // A cross-source copy is archived with its root card, never on its own.
  items.push({ ...item('hn', 101), clusterOf: 'hn:0' });
  items[0]!.briefZh = '长'.repeat(2000);
  const [digest] = buildDailyDigests(items, now);
  expect(digest!.total).toBe(110);
  expect(digest!.entries).toHaveLength(12);
  // Quality-first still caps each source, so the digest spans several sources.
  expect(new Set(digest!.entries.map((entry) => entry.source)).size).toBeGreaterThanOrEqual(6);
  // Curated sources win ties on source quality rather than source order.
  expect(digest!.entries.slice(0, 2).map((entry) => entry.source)).toEqual(['simonw', 'simonw']);
  for (const source of SOURCE_IDS) expect(digest!.entries.filter((entry) => entry.source === source).length).toBeLessThanOrEqual(2);
  expect(digest!.entries.every((entry) => entry.summary.length <= 221)).toBe(true);
  expect(isDailyDigest(digest)).toBe(true);
  expect(buildDailyDigests([...items].reverse(), now)).toEqual([digest]);
});

it('prefers quality over rotation while keeping diversity as a constraint', () => {
  const items = [
    { ...item('hn', 1), hotScore: 100, isHot: true },
    { ...item('hn', 2), hotScore: 90, isHot: true },
    { ...item('hn', 3), hotScore: 80, isHot: true },
    { ...item('v2ex', 1), hotScore: 50, isHot: true },
    { ...item('simonw', 1), hotScore: 0, isHot: false },
    // A high-engagement X joke is already filtered by the hot eligibility gate.
    { ...item('x', 1), hotScore: 200, isHot: true, hotEligible: false },
  ];
  const [digest] = buildDailyDigests(items, now);
  expect(digest!.entries.map((entry) => entry.id)).not.toContain('x:1');
  expect(digest!.entries.filter((entry) => entry.source === 'hn')).toHaveLength(2);
  expect(new Set(digest!.entries.map((entry) => entry.source))).toEqual(new Set(['hn', 'v2ex', 'simonw']));
  expect(digest!.entries[0]!.id).toBe('hn:1');
  expect(digest!.entries[0]!.reason).toContain('质量优先');
});

it('skips days whose only items fail the hot gate', () => {
  // A joke-only X batch is hot-ineligible and produces no entries. The
  // archive endpoint rejects an empty digest with 400, so publishing it at
  // all would just burn a doomed request.
  const items = [
    { ...item('x', 1), hotEligible: false },
    { ...item('x', 2), hotEligible: false },
  ];
  expect(buildDailyDigests(items, now)).toEqual([]);
});

it('does not count the Tech Twitter aggregator page as an external article', () => {
  const base = { ...item('x', 1), title: 'Short post', body: 'Short body' };
  const plain = dailyQuality({ ...base, extra: {} });
  expect(dailyQuality({ ...base, extra: { canonicalUrl: 'https://www.techtwitter.com/tweet/1' } })).toBe(plain);
  expect(dailyQuality({ ...base, extra: { canonicalUrl: 'https://example.com/article' } })).toBe(plain + 5);
});

it('summarizes an X post with its translated body', () => {
  const items = [{
    ...item('x', 1),
    body: 'An English post about compilers.',
    bodyZh: '一篇关于编译器的中文正文。',
    brief: 'English brief',
    briefZh: '中文摘要',
  }];
  const [digest] = buildDailyDigests(items, now);
  expect(digest!.entries[0]!.summary).toBe('一篇关于编译器的中文正文。');
});

it('uses Beijing calendar days and preserves repository and product names', () => {
  const items = [item('hn', 1, Date.parse('2026-11-12T15:59:59Z')), item('hn', 2, Date.parse('2026-11-12T16:00:00Z')),
    { ...item('github'), title: 'owner/repository', titleZh: '错误翻译' }, { ...item('producthunt'), title: 'Product', titleZh: '错误翻译' }];
  const digests = buildDailyDigests(items, now);
  expect(digests.map((digest) => digest.day)).toEqual(['2026-11-12', '2026-11-13']);
  expect(digests[0]!.total).toBe(1);
  expect(digests[1]!.entries.find((entry) => entry.source === 'github')!.title).toBe('owner/repository');
  expect(digests[1]!.entries.find((entry) => entry.source === 'github')!.originalTitle).toBeUndefined();
  expect(digests[1]!.entries.find((entry) => entry.source === 'producthunt')!.title).toBe('Product');
  expect(digests[1]!.entries.find((entry) => entry.source === 'producthunt')!.originalTitle).toBeUndefined();
});

it('drops placeholder AI briefs and keeps the original English title alongside translations', () => {
  const items = [
    { ...item('simonw', 1), title: 'Gemini Decisions API', titleZh: 'Gemini 决策 API', brief: 'Original English summary.', briefZh: '因文中信息量不足，暂无法概括。' },
    { ...item('google-ai', 2), title: 'New Release', titleZh: '新版本发布', brief: 'Release notes.', briefZh: '无' },
    { ...item('v2ex', 3), title: '中文原标题', titleZh: null, brief: '中文摘要', briefZh: null },
  ];
  const [digest] = buildDailyDigests(items, now);
  expect(isDailyDigest(digest)).toBe(true);
  const simonw = digest!.entries.find((entry) => entry.source === 'simonw')!;
  expect(simonw.title).toBe('Gemini 决策 API');
  expect(simonw.originalTitle).toBe('Gemini Decisions API');
  expect(simonw.summary).toBe('Original English summary.');
  const google = digest!.entries.find((entry) => entry.source === 'google-ai')!;
  expect(google.summary).toBe('Release notes.');
  expect(digest!.entries.find((entry) => entry.source === 'v2ex')!.originalTitle).toBeUndefined();
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
  expect(await publishDailyDigests({ baseUrl: 'https://jing.show', ingestToken: 'test', prewarmTranslations: false, dedupe: DEDUPE_DEFAULTS, cluster: CLUSTER_DEFAULTS }, items, 'lease-token', 'new-snapshot')).toBe(1);
  expect(writes[0]!.path).toBe('/api/admin/daily/2026-11-12');
  expect(writes[0]!.headers.get('x-publisher-lease')).toBe('lease-token');
  expect(writes[0]!.headers.get('x-expected-snapshot')).toBe('new-snapshot');
});

it('submits updated archive URLs to IndexNow when configured and never blocks on errors', async () => {
  vi.useFakeTimers(); vi.setSystemTime(now);
  const items = [item('hn', 2, now - 86400000)];
  const calls: Array<{ url: string; method?: string; body?: string }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method, body: typeof init?.body === 'string' ? init.body : undefined });
    if (url.includes('/api/admin/daily?')) return new Response(JSON.stringify({ hashes: {} }));
    return new Response('{}', { status: 200 });
  }));
  const config = {
    baseUrl: 'https://jing.show',
    ingestToken: 'test',
    prewarmTranslations: false,
    dedupe: DEDUPE_DEFAULTS,
    cluster: CLUSTER_DEFAULTS,
    indexNowKey: '060ed4eb07bf8fd6c4a538ff7fbf03d7',
  };
  expect(await publishDailyDigests(config, items, 'lease-token', 'new-snapshot')).toBe(1);
  const ping = calls.find((call) => call.url === 'https://api.indexnow.org/indexnow')!;
  expect(ping).toBeDefined();
  expect(JSON.parse(ping.body!)).toEqual({
    host: 'jing.show',
    key: '060ed4eb07bf8fd6c4a538ff7fbf03d7',
    keyLocation: 'https://jing.show/060ed4eb07bf8fd6c4a538ff7fbf03d7.txt',
    urlList: [
      'https://jing.show/',
      'https://jing.show/hot',
      'https://jing.show/daily',
      'https://jing.show/daily/2026-11-12',
    ],
  });

  // Never pings IndexNow for local dev URLs, and swallows upstream failures gracefully.
  expect(await notifyIndexNow({ ...config, baseUrl: 'http://127.0.0.1:8787' }, ['2026-11-12'])).toBe(false);
  vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 503 })));
  expect(await notifyIndexNow(config, ['2026-11-12'])).toBe(false);
});
