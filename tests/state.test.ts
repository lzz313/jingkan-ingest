import { describe, expect, it } from 'vitest';
import { applyEvent, bootstrapRecords, enrichmentRecords, reconcileDuplicatePointers, reconcileRemovedMap, reconcileState, deduplicateStateImages, mergeItems, pruneState, removedItems, sourcesWithLatestItemAt, updateSources, visibleItems, isSourceWindow, STATE_RETENTION_MS, type GeneratorState, type StoredItem } from '../src/ingest/state';
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
  it('marks X hot eligibility from trust or a cross-source confirmation', () => {
    const s = state();
    mergeItems(s, [
      post({ source: 'x', externalId: 'trusted', authorHandle: 'trq212' }),
      post({ source: 'x', externalId: 'random', authorHandle: 'randomacct' }),
      post({ source: 'hn', externalId: '9', title: 'Same story on Hacker News' }),
    ], now);
    // Another source discussing the same story confirms the random X post.
    s.records.get('hn:9')!.clusterOf = 'x:random';

    const items = visibleItems(s, { trustedXHandles: new Set(['trq212']) });
    const byId = new Map(items.map((item) => [item.id, item]));
    expect(byId.get('x:trusted')?.hotEligible).toBe(true);
    expect(byId.get('x:random')?.hotEligible).toBe(true);
    expect(items.find((item) => item.id === 'hn:9')?.hotEligible).toBeUndefined();

    const untrusted = visibleItems(s, { trustedXHandles: new Set(['someoneelse']) });
    expect(untrusted.find((item) => item.id === 'x:trusted')?.hotEligible).toBe(false);

    // The rollback switch leaves every X post eligible again.
    const disabled = visibleItems(s, { hotGateEnabled: false });
    expect(disabled.find((item) => item.id === 'x:trusted')?.hotEligible).toBeUndefined();
    expect(disabled.find((item) => item.id === 'x:random')?.hotEligible).toBeUndefined();

    // Derived eligibility must not be frozen into private state on bootstrap.
    const [record] = bootstrapRecords(untrusted);
    expect(record!.item.hotEligible).toBeUndefined();
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
  it('computes per-source latestItemAt from visible non-clustered items only', () => {
    const s = state();
    mergeItems(s, [
      post({ source: 'simonw', externalId: '1', publishedAt: now - 50000 }),
      post({ source: 'simonw', externalId: '2', publishedAt: now - 10000 }),
      post({ source: 'hn', externalId: '1', publishedAt: now - 20000 }),
      post({ source: 'hn', externalId: '2', publishedAt: now - 1000 }),
    ], now);
    // Clustered child and hidden items must not advance latestItemAt.
    s.records.get('hn:2')!.clusterOf = 'hn:1';
    const enriched = sourcesWithLatestItemAt(
      {
        simonw: { ok: true, lastUpdated: now },
        hn: { ok: true, lastUpdated: now },
        'google-ai': { ok: false, lastUpdated: now, lastError: 'timeout' },
      },
      visibleItems(s),
    );
    expect(enriched.simonw?.latestItemAt).toBe(now - 10000);
    expect(enriched.hn?.latestItemAt).toBe(now - 20000);
    expect(enriched['google-ai']?.latestItemAt).toBeUndefined();
  });
  it('uses the approved Beijing source-fetch slots', () => {
    expect(isSourceWindow(Date.UTC(2026, 10, 13, 0, 30))).toBe(true);
    expect(isSourceWindow(Date.UTC(2026, 10, 13, 4, 15))).toBe(false);
    expect(isSourceWindow(Date.UTC(2026, 10, 13, 4, 30))).toBe(true);
    expect(isSourceWindow(Date.UTC(2026, 10, 13, 16))).toBe(false);
  });
  it('fetches once per hour in the quiet 06:00–08:00 window', () => {
    // Beijing 06:00–08:00 opens only the first ten minutes of each hour.
    expect(isSourceWindow(Date.UTC(2026, 10, 12, 21, 59))).toBe(false); // 05:59
    expect(isSourceWindow(Date.UTC(2026, 10, 12, 22, 0))).toBe(true); // 06:00
    expect(isSourceWindow(Date.UTC(2026, 10, 12, 22, 9))).toBe(true); // 06:09
    expect(isSourceWindow(Date.UTC(2026, 10, 12, 22, 10))).toBe(false); // 06:10
    expect(isSourceWindow(Date.UTC(2026, 10, 12, 22, 30))).toBe(false); // 06:30
    expect(isSourceWindow(Date.UTC(2026, 10, 12, 23, 0))).toBe(true); // 07:00
    expect(isSourceWindow(Date.UTC(2026, 10, 12, 23, 9))).toBe(true); // 07:09
    expect(isSourceWindow(Date.UTC(2026, 10, 12, 23, 10))).toBe(false); // 07:10
    expect(isSourceWindow(Date.UTC(2026, 10, 13, 0))).toBe(false); // 08:00
  });
});

describe('operator maintenance overrides', () => {
  it('keeps an operator unhide through policy repair and later fetches', () => {
    const s = state();
    mergeItems(s, [post({ source: 'v2ex', extra: { node: 'programmer' } })], now);
    s.records.get('v2ex:1')!.moderation = 'keep';
    applyEvent(s, { kind: 'maintenance', patches: [{ id: 'v2ex:1', hidden: false }], createdAt: now });
    expect(s.records.get('v2ex:1')!.manualHidden).toBe(true);
    expect(visibleItems(s).map((item) => item.id)).toEqual(['v2ex:1']);

    // The node later becomes a promotion; the operator decision still wins.
    s.records.get('v2ex:1')!.item.extra = { node: 'promotions', nodeTitle: '推广' };
    expect(reconcileState(s).hidden).toBe(0);
    expect(visibleItems(s).map((item) => item.id)).toEqual(['v2ex:1']);

    mergeItems(s, [post({ source: 'v2ex', extra: { node: 'promotions', nodeTitle: '推广' } })], now + 3600000);
    expect(s.records.get('v2ex:1')!.item.hidden).toBe(false);
    expect(s.records.get('v2ex:1')!.manualHidden).toBe(true);
    expect(visibleItems(s).map((item) => item.id)).toEqual(['v2ex:1']);
  });

  it('keeps an operator-curated image list across later fetches', () => {
    const s = state();
    mergeItems(s, [post({ images: ['https://example.com/source.png'] })], now);
    applyEvent(s, { kind: 'maintenance', patches: [{ id: 'hn:1', images: [] }], createdAt: now });
    expect(s.records.get('hn:1')!.item.images).toEqual([]);
    expect(s.records.get('hn:1')!.manualImages).toBe(true);

    mergeItems(s, [post({ images: ['https://example.com/source.png'] })], now + 3600000);
    expect(s.records.get('hn:1')!.item.images).toEqual([]);
    expect(s.records.get('hn:1')!.manualImages).toBe(true);
  });
});

describe('enrichment downgrade protection', () => {
  it('never downgrades a syndication-enriched X record to a fallback card', () => {
    const s = state();
    mergeItems(s, [post({
      source: 'x',
      title: 'Claude can now use tools',
      body: 'The full syndicated post body.',
      author: 'Claude',
      authorHandle: 'claudeai',
      metrics: { likes: 10, replies: 2 },
      images: ['https://pbs.twimg.com/media/a.jpg'],
      extra: { provider: 'tech-twitter', statsSource: 'x-syndication' },
    })], now);
    s.records.get('x:1')!.item.titleZh = '克劳德现在可以使用工具';
    s.records.get('x:1')!.item.bodyZh = '完整的中文正文。';

    mergeItems(s, [post({
      source: 'x',
      title: 'Claude can now use tools',
      body: 'Short aggregator summary.',
      metrics: { qualityScore: 9 },
      images: [],
      contentHash: 'degraded-hash',
      extra: { provider: 'tech-twitter', statsSource: 'tech-twitter' },
    })], now + 3600000);

    expect(s.records.get('x:1')!.item).toMatchObject({
      body: 'The full syndicated post body.',
      titleZh: '克劳德现在可以使用工具',
      bodyZh: '完整的中文正文。',
      author: 'Claude',
      authorHandle: 'claudeai',
      metrics: { likes: 10, replies: 2 },
      images: ['https://pbs.twimg.com/media/a.jpg'],
    });
  });

  it('keeps full RSS text when a Jina proxy fallback returns less', () => {
    const s = state();
    mergeItems(s, [post({ source: 'simonw', body: 'The full post body from the feed.', extra: { timeSource: 'rss' } })], now);
    mergeItems(s, [post({
      source: 'simonw', body: 'Short proxy text.', contentHash: 'proxy-hash',
      extra: { timeSource: 'rss', proxy: 'jina' },
    })], now + 3600000);

    expect(s.records.get('simonw:1')!.item.body).toBe('The full post body from the feed.');
  });
});

describe('brief validation', () => {
  it('rejects model meta-notes when storing or repairing a brief', () => {
    const s = state();
    mergeItems(s, [post({ source: 'simonw' })], now);
    const record = s.records.get('simonw:1')!;
    applyEvent(s, {
      kind: 'enrichment', createdAt: now,
      entries: [{ id: 'simonw:1', contentHash: record.item.contentHash, field: 'briefZh', text: '因文中信息量不足，暂无法概括。' }],
    });
    expect(record.item.briefZh).toBeNull();

    record.item.briefZh = '无';
    expect(reconcileState(s).translationsReset).toBe(1);
    expect(record.item.briefZh).toBeNull();

    applyEvent(s, {
      kind: 'enrichment', createdAt: now,
      entries: [{ id: 'simonw:1', contentHash: record.item.contentHash, field: 'briefZh', text: '一个真正的中文要点。' }],
    });
    expect(record.item.briefZh).toBe('一个真正的中文要点。');
  });
});

describe('policy repair of retained data', () => {
  it('removes old promotion-node posts even when the source no longer returns them', () => {
    const s = state(); mergeItems(s, [post({ source: 'v2ex', extra: { node: 'programmer' } })], now);
    const record = s.records.get('v2ex:1')!; record.moderation = 'keep'; record.item.extra = { node: 'promotions', nodeTitle: '推广' };
    expect(reconcileState(s).hidden).toBe(1);
    expect(visibleItems(s)).toEqual([]); expect(removedItems(s)).toHaveProperty('v2ex:1');
  });
  it('clears old English echoes and rejects their journal replay', () => {
    const s = state(); mergeItems(s, [post()], now);
    const record = s.records.get('hn:1')!; record.item.titleZh = record.item.title;
    expect(reconcileState(s).translationsReset).toBe(1); expect(record.item.titleZh).toBeNull();
    applyEvent(s, { kind: 'enrichment', createdAt: now, entries: [{ id: 'hn:1', contentHash: record.item.contentHash, field: 'titleZh', text: record.item.title }] });
    expect(record.item.titleZh).toBeNull();
  });
  it('preserves a Chinese X title translation on subsequent metric updates', () => {
    const s = state(); mergeItems(s, [post({ source: 'x' })], now);
    s.records.get('x:1')!.item.titleZh = '编译器研究';
    mergeItems(s, [post({ source: 'x' })], now + 3600000);
    expect(s.records.get('x:1')!.item.titleZh).toBe('编译器研究');
  });
});

it('repairs retained image variants without changing timestamps or content hashes', () => {
  const s = state(); mergeItems(s, [post({ source: 'linuxdo' })], now);
  const record = s.records.get('linuxdo:1')!;
  const hash = 'e501efabb23b73adbfd8e2eca3ff2f4532c1ac82';
  const original = `https://cdn3.ldstatic.com/original/4X/e/5/0/${hash}.jpeg`;
  record.item.images = [original.replace('/original/', '/optimized/').replace('.jpeg', '_2_287x500.jpeg'), original];
  const before = { fetchedAt: record.item.fetchedAt, contentHash: record.item.contentHash, observedAt: record.observedAt, lastUpdated: s.lastUpdated };
  expect(deduplicateStateImages(s)).toBe(1);
  expect(record.item.images).toEqual([original]);
  expect({ fetchedAt: record.item.fetchedAt, contentHash: record.item.contentHash, observedAt: record.observedAt, lastUpdated: s.lastUpdated }).toEqual(before);
  expect(deduplicateStateImages(s)).toBe(0);
});

describe('duplicate pointers', () => {
  function pointerState(): { state: GeneratorState; canonical: StoredItem; duplicate: StoredItem } {
    const s = state();
    mergeItems(s, [post({ source: 'nodeseek' }), post({ source: 'nodeseek', externalId: '2' })], now);
    const canonical = s.records.get('nodeseek:1')!;
    const duplicate = s.records.get('nodeseek:2')!;
    duplicate.duplicateOf = 'nodeseek:1';
    duplicate.dedupe = { hash: duplicate.item.contentHash, config: 'fp', checkedAt: now, canonicalHash: canonical.item.contentHash };
    return { state: s, canonical, duplicate };
  }

  it('hides duplicates from feed and enrichment while reporting them as removed', () => {
    const { state: s, canonical, duplicate } = pointerState();
    canonical.moderation = 'keep';
    duplicate.moderation = 'keep';
    expect(visibleItems(s).map((item) => item.id)).toEqual(['nodeseek:1']);
    expect(removedItems(s)).toEqual({ 'nodeseek:2': duplicate.item.publishedAt });
    expect(enrichmentRecords(s).map((record) => record.item.id)).toEqual(['nodeseek:1']);
  });

  it('keeps pointers through metric refreshes and clears them when the post is edited', () => {
    const { state: s } = pointerState();
    mergeItems(s, [post({ source: 'nodeseek', externalId: '2' })], now + 3600000);
    expect(s.records.get('nodeseek:2')!.duplicateOf).toBe('nodeseek:1');
    expect(s.records.get('nodeseek:2')!.dedupe?.config).toBe('fp');
    mergeItems(s, [post({ source: 'nodeseek', externalId: '2', title: 'Rewritten topic' })], now + 7200000);
    expect(s.records.get('nodeseek:2')!.duplicateOf).toBeUndefined();
    expect(s.records.get('nodeseek:2')!.dedupe).toBeUndefined();
  });

  it('keeps pointers through pending or chained canonicals', () => {
    const pending = pointerState();
    pending.canonical.moderation = 'pending';
    expect(reconcileDuplicatePointers(pending.state)).toBe(0);
    expect(pending.duplicate.duplicateOf).toBe('nodeseek:1');

    const chained = pointerState();
    chained.canonical.duplicateOf = 'nodeseek:0';
    expect(reconcileDuplicatePointers(chained.state)).toBe(0);
    expect(chained.duplicate.duplicateOf).toBe('nodeseek:1');
  });

  it('keeps a pointer whose canonical was pruned so old posts never resurface', () => {
    const { state: s, duplicate } = pointerState();
    s.records.delete('nodeseek:1');
    expect(reconcileDuplicatePointers(s)).toBe(0);
    expect(duplicate.duplicateOf).toBe('nodeseek:1');
  });

  it('releases pointers when the canonical is hidden or rewritten', () => {
    const mutations: Array<(canonical: StoredItem) => void> = [
      (canonical) => { canonical.ruleHidden = true; },
      (canonical) => { canonical.moderation = 'hide'; },
      (canonical) => { canonical.item.contentHash = 'rewritten'; },
    ];
    for (const mutate of mutations) {
      const { state: s, canonical, duplicate } = pointerState();
      mutate(canonical);
      expect(reconcileDuplicatePointers(s)).toBe(1);
      expect(duplicate.duplicateOf).toBeUndefined();
      expect(duplicate.dedupe).toBeUndefined();
    }
  });

  it('rebuilds the removed map without resurrecting pending or pruned records', () => {
    const s = state();
    mergeItems(s, [post({ source: 'nodeseek' }), post({ source: 'nodeseek', externalId: '2' }), post({ source: 'nodeseek', externalId: '3' })], now);
    s.records.get('nodeseek:1')!.moderation = 'keep';
    s.records.get('nodeseek:2')!.moderation = 'keep';
    s.records.get('nodeseek:2')!.duplicateOf = 'nodeseek:1';
    const removed = reconcileRemovedMap({
      'nodeseek:1': now - 1000,
      'nodeseek:2': now - 1000,
      'nodeseek:3': now - 1000,
      'gone:1': now - 1000,
      'gone:old': now - STATE_RETENTION_MS - 1,
    }, s, now);
    expect(removed).not.toHaveProperty('nodeseek:1');
    expect(removed).toHaveProperty('nodeseek:2');
    expect(removed).toHaveProperty('nodeseek:3');
    expect(removed).toHaveProperty('gone:1');
    expect(removed).not.toHaveProperty('gone:old');
  });
});

describe('cross-source cluster visibility', () => {
  it('keeps merged copies resolvable and folds one link per source into the root', () => {
    const s = state();
    mergeItems(s, [
      post({ source: 'hn', externalId: '1', title: 'Root story' }),
      post({ source: 'v2ex', externalId: '2', title: 'V2EX copy', publishedAt: now - 15000 }),
      post({ source: 'x', externalId: '3', title: 'X copy', publishedAt: now - 5000 }),
      post({ source: 'x', externalId: '4', title: 'X earlier copy', publishedAt: now - 20000 }),
    ], now);
    for (const record of s.records.values()) record.moderation = 'keep';
    for (const id of ['v2ex:2', 'x:3', 'x:4']) {
      s.records.get(id)!.clusterOf = 'hn:1';
      s.records.get(id)!.cluster = { hash: s.records.get(id)!.item.contentHash, config: 'fp', checkedAt: now };
    }

    const items = visibleItems(s);
    expect(items.map((item) => item.id)).toEqual(['hn:1', 'v2ex:2', 'x:3', 'x:4']);
    expect(items.find((item) => item.id === 'v2ex:2')?.clusterOf).toBe('hn:1');
    const root = items.find((item) => item.id === 'hn:1')!;
    // Two X posts collapsed to the earliest; every related link is another source.
    expect(root.related?.map((entry) => entry.id)).toEqual(['x:4', 'v2ex:2']);
    expect(root.related?.every((entry) => entry.source !== root.source)).toBe(true);
    // Merged copies are still favourites candidates, not removed IDs.
    expect(removedItems(s)).toEqual({});

    // Public derived fields must not become private state on a fresh bootstrap.
    const [rootRecord] = bootstrapRecords([root]);
    const [childRecord] = bootstrapRecords([items.find((item) => item.id === 'v2ex:2')!]);
    expect(rootRecord!.item.related).toBeUndefined();
    expect(childRecord!.item.clusterOf).toBeUndefined();
  });
});
