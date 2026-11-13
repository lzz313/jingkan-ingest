import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSnapshot, type SnapshotManifest } from '../src/ingest/snapshot';
import { readBaseItems } from '../src/ingest/snapshot-client';
import { runPublisher, selectBacklog } from '../src/ingest/publisher';
import { fetchSources } from '../src/ingest/sources';
import type { FeedItem } from '../src/shared/types';
vi.mock('../src/ingest/sources', () => ({ fetchSources: vi.fn(async () => ({ items: [], sourceStatus: {} })) }));
const config = { baseUrl: 'https://jing.show', ingestToken: 'test', prewarmTranslations: false };
const post = (id: string): FeedItem => ({
  id, source: 'hn', externalId: id.split(':')[1]!, storyKey: null, title: id, titleZh: null,
  body: 'content', brief: null, briefZh: null, bodyZh: null, url: 'https://example.com/' + id,
  author: null, authorHandle: null, publishedAt: Date.now(), fetchedAt: Date.now(), firstSeenAt: Date.now(),
  metrics: {}, hotScore: 1, isHot: false, images: [], extra: {}, hidden: false, contentHash: id,
});
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
beforeEach(() => { vi.mocked(fetchSources).mockReset().mockResolvedValue({ items: [], sourceStatus: {} }); });
function mockServer(options: { uploadFails?: boolean; conflict?: boolean; renewFails?: boolean; events?: boolean; corrupt?: boolean; imageVariants?: boolean } = {}) {
  const meta = { dataVersion: 1, lastUpdated: 100, lastRefreshAt: 0, sources: {} };
  const baseItem = post('hn:1');
  const originalImage = 'https://cdn3.ldstatic.com/original/4X/e/5/0/e501efabb23b73adbfd8e2eca3ff2f4532c1ac82.jpeg';
  if (options.imageVariants) baseItem.images = [originalImage.replace('/original/', '/optimized/').replace('.jpeg', '_2_287x500.jpeg'), originalImage];
  const base = buildSnapshot([baseItem], meta);
  const uploadedParts = new Map<number, Buffer>();
  const paths: string[] = [], uploads: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (request: string | URL, init?: RequestInit) => {
    const url = new URL(request), method = init?.method ?? 'GET';
    paths.push(method + ' ' + url.pathname);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    if (url.pathname.endsWith('/publisher')) {
      if (body.action === 'renew' && options.renewFails) return json({ error: 'lease expired' }, 409);
      return json({ lease: { token: 'lease', expiresAt: Date.now() + 180000 }, lastRefreshAt: 0 });
    }
    if (url.pathname.endsWith('/base')) return json(base.manifest);
    if (url.pathname.endsWith('/artifact') && method === 'GET') return new Response(options.corrupt ? 'broken' : new Uint8Array(base.artifacts[Number(url.searchParams.get('part') ?? 0)]!.body));
    if (url.pathname === '/api/admin/events') {
      if (url.searchParams.has('key')) return json({ kind: 'enrichment', entries: [{ id: 'hn:1', contentHash: 'hn:1', field: 'titleZh', text: '译文' }], createdAt: Date.now() });
      return json({ keys: options.events ? ['feed/events/2026-11-13/11111111-1111-1111-1111-111111111111.json'] : [], cursor: null });
    }
    if (url.pathname.endsWith('/cleanup')) return json({ cursor: null });
    if (url.pathname.endsWith('/ack')) return json({ ok: true });
    if (url.pathname === '/api/admin/daily') return json({ hashes: {} });
    if (method === 'PUT') {
      if (url.pathname.endsWith('/manifest')) uploads.push(body);
      if (url.pathname.endsWith('/artifact')) uploadedParts.set(Number(url.searchParams.get('part')), Buffer.from(init!.body as Uint8Array));
      return options.uploadFails ? json({ error: 'upload failed' }, 503) : json({ ok: true });
    }
    if (url.pathname.endsWith('/activate')) {
      expect(new Headers(init?.headers).get('x-publisher-lease')).toBe('lease');
      expect(new Headers(init?.headers).get('x-expected-snapshot')).toBe(base.manifest.snapshotId);
      return json({ ok: !options.conflict }, options.conflict ? 409 : 200);
    }
    if (url.pathname.endsWith('/enrich')) return json({ error: 'AI unavailable' }, 503);
    throw new Error('Unexpected request: ' + url.pathname);
  }));
  return { paths, uploads, base, uploadedParts, originalImage };
}
it('rotates translation sources and alternates fresh items with older backlog', () => {
  const items = [post('hn:new'), post('hn:middle'), post('hn:old'), { ...post('reddit:new'), source: 'reddit' as const }, { ...post('reddit:old'), source: 'reddit' as const }];
  expect(selectBacklog(items, 4).map((item) => item.id)).toEqual(['hn:new', 'reddit:new', 'hn:old', 'reddit:old']);
  expect(items).toHaveLength(5);
});
describe('single fenced R2 publisher', () => {
  it('bootstraps from R2, preserves source timestamps and writes private generator state', async () => {
    const { paths, uploads } = mockServer(); await runPublisher(config, { repackOnly: true });
    expect(fetchSources).not.toHaveBeenCalled();
    expect(paths.some((path) => /sync|export/.test(path))).toBe(false);
    expect(uploads[0]).toMatchObject({ lastUpdated: 100, dataVersion: 2, generatorStateParts: expect.any(Array) });
  });
  it('repairs both public and private image lists during repacking', async () => {
    const { uploads, uploadedParts, originalImage } = mockServer({ imageVariants: true });
    await runPublisher(config, { repackOnly: true });
    const manifest = uploads[0] as SnapshotManifest;
    const read = (ranges: SnapshotManifest['canonicalParts']) => ranges.flatMap((range) => {
      const part = manifest.artifacts.findIndex((artifact) => artifact.key === range.key);
      return JSON.parse(uploadedParts.get(part)!.subarray(range.offset, range.offset + range.length).toString());
    });
    expect(read(manifest.canonicalParts)[0].images).toEqual([originalImage]);
    expect(read(manifest.generatorStateParts!)[0].item.images).toEqual([originalImage]);
    expect(manifest.lastUpdated).toBe(100);
  });
  it('stops its renewal timer after releasing the publication lease', async () => {
    vi.useFakeTimers(); mockServer();
    await runPublisher(config, { repackOnly: true });
    expect(vi.getTimerCount()).toBe(0);
  });
  it('verifies base pack checksums before reading records', async () => {
    const { base, paths } = mockServer({ corrupt: true });
    await expect(readBaseItems(config, base.manifest)).rejects.toThrow('integrity');
    expect(paths.some((path) => path.includes('/activate'))).toBe(false);
  });
  it('does not activate or acknowledge inputs after an upload failure', async () => {
    const { paths } = mockServer({ uploadFails: true, events: true });
    await expect(runPublisher(config, { forceFetch: true })).rejects.toThrow('upload failed');
    expect(paths.some((path) => path.includes('/activate'))).toBe(false);
    expect(paths.some((path) => path.includes('/ack'))).toBe(false);
  });
  it('acknowledges journal entries only after successful activation', async () => {
    const { paths, uploads } = mockServer({ events: true }); await runPublisher(config, { forceFetch: true });
    expect(paths.findIndex((path) => path.includes('/ack'))).toBeGreaterThan(paths.findIndex((path) => path.includes('/activate')));
    expect(uploads[0]).toMatchObject({ processedEvents: expect.arrayContaining([expect.stringContaining('feed/events/')]) });
  });
  it('retains queued inputs on a conflicting snapshot pointer', async () => {
    const { paths } = mockServer({ conflict: true, events: true });
    await expect(runPublisher(config, { forceFetch: true })).rejects.toThrow('409');
    expect(paths.some((path) => path.includes('/ack'))).toBe(false);
  });
  it('never uploads after losing its publisher lease', async () => {
    const { paths } = mockServer({ renewFails: true });
    await expect(runPublisher(config, { repackOnly: true })).rejects.toThrow('409');
    expect(paths.some((path) => path.startsWith('PUT'))).toBe(false);
  });
  it('leaves failed moderation pending and still publishes curated sources', async () => {
    const { uploads } = mockServer();
    vi.mocked(fetchSources).mockResolvedValue({ items: [{ source: 'v2ex', externalId: 'new', title: 'A useful question', url: 'https://v2ex.com/t/1', publishedAt: Date.now() }], sourceStatus: { v2ex: { ok: true, count: 1 } } });
    await runPublisher(config, { forceFetch: true });
    expect(uploads[0]).toMatchObject({ generatorStateParts: expect.any(Array), removed: {} });
  });
});
