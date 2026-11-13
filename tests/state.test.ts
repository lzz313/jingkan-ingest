import { describe, expect, it } from 'vitest';
import { applyEvent, bootstrapRecords, mergeItems, pruneState, removedItems, updateSources, visibleItems, isSourceWindow, type GeneratorState } from '../src/ingest/state';
import type { NormalizedItem, FeedItem } from '../src/shared/types';
const now = Date.UTC(2026, 10, 13, 2);
function state(): GeneratorState { return { records: new Map(), sources: {}, lastUpdated: 0, lastRefreshAt: 0, lastIngestAttemptAt: 0 }; }
function post(overrides: Partial<NormalizedItem> = {}): NormalizedItem {
  return { source: 'hn', externalId: '1', title: 'Interesting compiler research', body: 'A useful article about compiler design.', url: 'https://example.com/a', publishedAt: now - 10000, metrics: { points: 50 }, ...overrides };
}
describe('R2 article merge', () => {
  it('keeps original HN URL, publication time, first-seen time and translations', () => {
    const s = state(); mergeItems(s, [post()], now);
    const old = s.records.get('hn:1')!; old.item.titleZh = '编译器研究';
    mergeItems(s, [post({ url: 'https://new.example/a', contentHash: old.item.contentHash!, publishedAt: now })], now + 3600000);
    expect(s.records.get('hn:1')!.item).toMatchObject({ url: 'https://example.com/a', publishedAt: now - 10000, firstSeenAt: now, titleZh: '编译器研究' });
  });
  it('refreshes GitHub ranking timestamps but keeps product names original', () => {
    const s = state(); mergeItems(s, [post({ source: 'github', titleZh: '不要翻译' })], now);
    mergeItems(s, [post({ source: 'github', publishedAt: now, titleZh: '不要翻译' })], now + 1);
    expect(s.records.get('github:1')!.item).toMatchObject({ publishedAt: now, titleZh: null });
  });
  it('throttles metric-only updates to once per hour and keeps latest observation', () => {
    const s = state(); mergeItems(s, [post()], now);
    expect(mergeItems(s, [post({ metrics: { points: 51 } })], now + 60000)).toBe(0);
    expect(s.records.get('hn:1')!.observedAt).toBe(now + 60000);
    expect(mergeItems(s, [post({ metrics: { points: 51 } })], now + 3600000)).toBe(1);
    expect(s.records.get('hn:1')!.item.metrics.points).toBe(51);
  });
  it('accepts hot-threshold crossings immediately', () => {
    const s = state(); mergeItems(s, [post({ metrics: { points: 1 } })], now);
    expect(mergeItems(s, [post({ metrics: { points: 1000 } })], now + 1)).toBe(1);
    expect(s.records.get('hn:1')!.item.isHot).toBe(true);
  });
  it('clears old translations on edits and retains images when adapters omit them', () => {
    const s = state(); mergeItems(s, [post({ images: ['https://example.com/a.png'] })], now);
    s.records.get('hn:1')!.item.titleZh = '旧内容';
    mergeItems(s, [post({ title: 'A different story' })], now + 1);
    expect(s.records.get('hn:1')!.item.titleZh).toBeNull();
    expect(s.records.get('hn:1')!.item.images).toEqual(['https://example.com/a.png']);
  });
  it('never lets replayed older input undo a newer edit', () => {
    const s = state(); mergeItems(s, [post()], now);
    mergeItems(s, [post({ title: 'New content' })], now + 10);
    mergeItems(s, [post()], now);
    expect(s.records.get('hn:1')!.item.title).toBe('New content');
  });
  it('ignores duplicated X engagement fields when comparing content', () => {
    const s = state(); mergeItems(s, [post({ source: 'x', extra: { viewsPerHour: 1, qualityScore: 1, corePosts: [{ url: 'https://x.com/a', likes: 1 }] } })], now);
    expect(mergeItems(s, [post({ source: 'x', extra: { viewsPerHour: 2, qualityScore: 2, corePosts: [{ url: 'https://x.com/a', likes: 2 }] } })], now + 1)).toBe(0);
  });
});
describe('visibility and durable verdicts', () => {
  it('holds new community posts pending without deleting favorites', () => {
    const s = state(); mergeItems(s, [post({ source: 'v2ex' })], now);
    expect(visibleItems(s)).toEqual([]); expect(removedItems(s)).toEqual({});
    const record = s.records.get('v2ex:1')!; record.moderation = 'hide';
    mergeItems(s, [post({ source: 'v2ex' })], now + 3600000);
    expect(removedItems(s)).toHaveProperty('v2ex:1');
    const restored = JSON.parse(JSON.stringify([...s.records.values()]));
    const next = { ...s, records: new Map(restored.map((r: { item: FeedItem }) => [r.item.id, r])) } as GeneratorState;
    expect(visibleItems(next)).toEqual([]);
  });
  it('requires a fresh verdict when community content changes', () => {
    const s = state(); mergeItems(s, [post({ source: 'v2ex' })], now);
    s.records.get('v2ex:1')!.moderation = 'keep';
    mergeItems(s, [post({ source: 'v2ex', title: 'Edited content' })], now + 1);
    expect(s.records.get('v2ex:1')!.moderation).toBe('pending'); expect(visibleItems(s)).toEqual([]);
  });
  it('trusts already visible legacy bootstrap records', () => {
    const s = state(); mergeItems(s, [post()], now);
    const bootstrap = bootstrapRecords(visibleItems(s));
    expect(bootstrap[0]!.moderation).toBe('keep');
  });
});
describe('events, retention and source freshness', () => {
  it('applies enrichment idempotently only to matching content hashes', () => {
    const s = state(); mergeItems(s, [post()], now);
    const event = { kind: 'enrichment' as const, entries: [{ id: 'hn:1', contentHash: s.records.get('hn:1')!.item.contentHash, field: 'titleZh' as const, text: '新译文' }], createdAt: now };
    applyEvent(s, event); applyEvent(s, event); expect(s.records.get('hn:1')!.item.titleZh).toBe('新译文');
    mergeItems(s, [post({ title: 'Edited story' })], now + 1); applyEvent(s, event);
    expect(s.records.get('hn:1')!.item.titleZh).toBeNull();
  });
  it('stages ingest and maintenance events without bypassing moderation', () => {
    const s = state(); applyEvent(s, { kind: 'ingest', items: [post({ source: 'v2ex' })], sourceStatus: { v2ex: { ok: true, count: 1 } }, createdAt: now });
    applyEvent(s, { kind: 'maintenance', patches: [{ id: 'v2ex:1', hidden: false }], createdAt: now });
    expect(visibleItems(s)).toEqual([]); expect(s.lastUpdated).toBe(now);
  });
  it('prunes hidden, pending and visible records outside 35 days', () => {
    const s = state(); mergeItems(s, [post({ publishedAt: now - 36 * 86400000 }), post({ source: 'v2ex', publishedAt: now - 36 * 86400000 })], now);
    pruneState(s, now - 35 * 86400000); expect(s.records.size).toBe(0);
  });
  it('does not claim new data on empty/failed sources or stale replay', () => {
    const s = state(); updateSources(s, { hn: { ok: true, count: 1 } }, now);
    updateSources(s, { hn: { ok: false, error: 'offline' } }, now + 1);
    updateSources(s, { x: { ok: true, count: 0 } }, now + 2);
    updateSources(s, { hn: { ok: true, count: 2 } }, now - 1);
    expect(s.lastUpdated).toBe(now); expect(s.sources.hn!.ok).toBe(false);
  });
  it('uses the approved Beijing source-fetch slots', () => {
    expect(isSourceWindow(Date.UTC(2026, 10, 13, 0, 30))).toBe(true);
    expect(isSourceWindow(Date.UTC(2026, 10, 13, 4, 15))).toBe(false);
    expect(isSourceWindow(Date.UTC(2026, 10, 13, 4, 30))).toBe(true);
    expect(isSourceWindow(Date.UTC(2026, 10, 13, 16))).toBe(false);
  });
});
