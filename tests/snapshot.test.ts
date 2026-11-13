import { describe, expect, it } from 'vitest';
import type { FeedItem, FeedResponse, SourceId } from '../src/shared/types';
import {
  buildFeedResponse,
  buildSnapshot,
  feedQueryKey,
  type FeedQuery,
  type SnapshotMeta,
} from '../src/ingest/snapshot';

const NOW = 1_800_000_000_000;

function item(
  id: string,
  source: SourceId,
  publishedAt: number,
  overrides: Partial<FeedItem> = {},
): FeedItem {
  return {
    id,
    source,
    externalId: id,
    storyKey: null,
    title: id,
    titleZh: null,
    body: null,
    brief: null,
    briefZh: null,
    bodyZh: null,
    url: `https://example.com/${id}`,
    author: null,
    authorHandle: null,
    publishedAt,
    firstSeenAt: publishedAt,
    fetchedAt: NOW,
    metrics: {},
    hotScore: 0,
    isHot: false,
    images: [],
    extra: {},
    hidden: false,
    contentHash: null,
    ...overrides,
  };
}

const items = [
  item('x:new', 'x', NOW - 1_000, { hotScore: 40, isHot: true }),
  item('x:old', 'x', NOW - 2_000, { hotScore: 90, isHot: true }),
  item('v2ex:new', 'v2ex', NOW - 3_000, { hotScore: 80, isHot: true }),
  item('simonw:new', 'simonw', NOW - 4_000),
  item('hn:stale', 'hn', NOW - 5_000, {
    fetchedAt: NOW - 2 * 24 * 60 * 60_000,
    hotScore: 100,
    isHot: true,
  }),
];

const meta: SnapshotMeta = {
  lastUpdated: NOW - 10,
  dataVersion: 7,
  lastRefreshAt: NOW - 20,
  sources: {},
};

function query(overrides: Partial<FeedQuery> = {}): FeedQuery {
  return {
    view: 'latest',
    source: 'all',
    limit: 30,
    ...overrides,
  };
}

describe('snapshot feed builder', () => {
  it('matches latest, balanced hot and rising semantics', () => {
    const latest = buildFeedResponse(items, query(), meta, NOW);
    expect(latest.items.map((entry) => entry.id)).toEqual([
      'x:new',
      'x:old',
      'v2ex:new',
      'simonw:new',
      'hn:stale',
    ]);
    expect(latest.counts).toEqual({
      all: 5,
      bySource: { x: 2, v2ex: 1, simonw: 1, hn: 1 },
    });
    expect(latest.totals).toEqual({ hot: 3, rising: 4 });

    const hot = buildFeedResponse(items, query({ view: 'hot' }), meta, NOW);
    expect(hot.items.map((entry) => entry.id)).toEqual([
      'x:old',
      'v2ex:new',
      'x:new',
    ]);
  });

  it('filters by source and produces stable cursors', () => {
    const first = buildFeedResponse(items, query({ source: 'x', limit: 1 }), meta, NOW);
    expect(first.items.map((entry) => entry.id)).toEqual(['x:new']);
    expect(first.nextCursor).toBeTruthy();
    const second = buildFeedResponse(
      items,
      query({ source: 'x', limit: 1, cursor: first.nextCursor ?? undefined }),
      meta,
      NOW,
    );
    expect(second.items.map((entry) => entry.id)).toEqual(['x:old']);
  });
});

describe('snapshot artifact', () => {
  it('packs canonical output and common responses into byte ranges', () => {
    const { pack, manifest } = buildSnapshot(items, meta, NOW);
    expect(manifest.packSize).toBe(pack.length);
    expect(manifest.packSha256).toMatch(/^[0-9a-f]{64}$/);

    const key = feedQueryKey(query());
    const range = manifest.responses[key];
    expect(range).toBeDefined();
    const response = JSON.parse(
      pack.subarray(range!.offset, range!.offset + range!.length).toString('utf8'),
    ) as FeedResponse;
    expect(response.items).toHaveLength(5);
    expect(response.dataVersion).toBe(7);

    const canonical = JSON.parse(
      pack
        .subarray(
          manifest.canonical.offset,
          manifest.canonical.offset + manifest.canonical.length,
        )
        .toString('utf8'),
    ) as { snapshotId: string; items: FeedItem[] };
    expect(canonical.snapshotId).toBe(manifest.snapshotId);
    expect(canonical.items).toHaveLength(5);
  });
});
