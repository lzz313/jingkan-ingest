import { createHash } from 'node:crypto';
import type {
  FeedItem,
  FeedResponse,
  FeedView,
  SourceCounts,
  SourceId,
  SourceStatus,
} from '../shared/types';
import { SOURCE_IDS } from '../shared/types';
import { LATEST_ONLY_SOURCES, isSourceId } from '../shared/sources';

const DAY_MS = 24 * 60 * 60_000;
const BEIJING_OFFSET_MS = 8 * 60 * 60_000;
const HOT_PER_SOURCE = 5;
const RISING_PER_SOURCE = 8;
const HOT_FRESH_MS = DAY_MS;
const RISING_WINDOW_MS = DAY_MS;
const SNAPSHOT_FORMAT_VERSION = 2;
export const SNAPSHOT_PACK_TARGET_BYTES = 8 * 1024 * 1024;
const CANONICAL_CHUNK_BYTES = 256 * 1024;

export interface SnapshotMeta {
  lastIngestAttemptAt?: number;
  processedEvents?: string[];
  removed?: Record<string, number>;
  lastUpdated: number;
  dataVersion: number;
  lastRefreshAt: number;
  sources: Partial<Record<SourceId, SourceStatus>>;
}

export interface SnapshotRange {
  key?: string;
  offset: number;
  length: number;
}

export interface SnapshotManifest extends SnapshotMeta {
  formatVersion: number;
  snapshotId: string;
  generatedAt: number;
  packKey: string;
  packSize: number;
  packSha256: string;
  canonical: SnapshotRange;
  responses: Record<string, SnapshotRange>;
  artifacts: Array<{ key: string; size: number; sha256: string }>;
  canonicalParts: SnapshotRange[];
  itemIndexes: Record<string, SnapshotRange>;
  catalog: SnapshotRange;
  generatorStateParts?: SnapshotRange[];
}

export interface SnapshotBuild {
  artifacts: Array<{ key: string; body: Buffer; sha256: string }>;
  manifest: SnapshotManifest;
}

export interface FeedQuery {
  view: FeedView;
  source: SourceId | 'all';
  from?: number;
  to?: number;
  limit: number;
  cursor?: string;
}

interface Cursor {
  p: number;
  h: number;
  id: string;
}

function compareLatest(a: FeedItem, b: FeedItem): number {
  return b.publishedAt - a.publishedAt || b.id.localeCompare(a.id);
}

function compareRanked(a: FeedItem, b: FeedItem): number {
  return b.hotScore - a.hotScore || compareLatest(a, b);
}

function inRange(item: FeedItem, from?: number, to?: number): boolean {
  return (
    (from === undefined || item.publishedAt >= from) &&
    (to === undefined || item.publishedAt <= to)
  );
}

function encodeCursor(item: FeedItem): string {
  return Buffer.from(
    JSON.stringify({ p: item.publishedAt, h: item.hotScore, id: item.id }),
  ).toString('base64url');
}

function decodeCursor(value: string): Cursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Cursor;
    return typeof parsed.p === 'number' &&
      typeof parsed.h === 'number' &&
      typeof parsed.id === 'string'
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function rankedPool(
  items: FeedItem[],
  view: 'hot' | 'rising',
  query: FeedQuery,
  now: number,
): { bySource: Map<string, FeedItem[]>; items: FeedItem[]; total: number } {
  const risingFrom =
    query.from ??
    (query.to !== undefined ? query.to - RISING_WINDOW_MS : now - RISING_WINDOW_MS);
  const groups = new Map<string, FeedItem[]>();
  for (const item of items) {
    if (view === 'hot') {
      if (item.fetchedAt < now - HOT_FRESH_MS) continue;
      if (LATEST_ONLY_SOURCES.has(item.source)) continue;
      if (item.source === 'hf-papers' && !item.isHot) continue;
      if (!inRange(item, query.from, query.to)) continue;
    } else {
      if (!item.isHot || !inRange(item, risingFrom, query.to)) continue;
    }
    const group = groups.get(item.source) ?? [];
    group.push(item);
    groups.set(item.source, group);
  }

  const perSource = view === 'rising' ? RISING_PER_SOURCE : HOT_PER_SOURCE;
  const bySource = new Map<string, FeedItem[]>();
  const ranked: FeedItem[] = [];
  let total = 0;
  for (const [source, group] of groups) {
    const top = group.sort(compareRanked).slice(0, perSource);
    bySource.set(source, top);
    ranked.push(...top);
    total += top.length;
  }
  ranked.sort(compareRanked);
  return { bySource, items: ranked, total };
}

export function buildFeedResponse(
  snapshotItems: FeedItem[],
  query: FeedQuery,
  meta: Pick<SnapshotMeta, 'lastUpdated' | 'dataVersion'>,
  now: number,
): FeedResponse {
  const hot = rankedPool(snapshotItems, 'hot', query, now);
  const rising = rankedPool(snapshotItems, 'rising', query, now);
  const totals = { hot: hot.total, rising: rising.total };
  const dated = snapshotItems.filter((item) => inRange(item, query.from, query.to));
  const countsBySource: Partial<Record<SourceId, number>> = {};
  for (const item of dated) {
    countsBySource[item.source] = (countsBySource[item.source] ?? 0) + 1;
  }
  const counts: SourceCounts = { all: dated.length, bySource: countsBySource };

  if (query.view === 'hot' || query.view === 'rising') {
    const ranked = query.view === 'hot' ? hot : rising;
    const rankedCounts: Partial<Record<SourceId, number>> = {};
    let all = 0;
    for (const [source, group] of ranked.bySource) {
      if (!isSourceId(source)) continue;
      rankedCounts[source] = group.length;
      all += group.length;
    }
    return {
      items: ranked.items
        .filter((item) => query.source === 'all' || item.source === query.source)
        .slice(0, query.limit),
      nextCursor: null,
      counts: { all, bySource: rankedCounts },
      totals,
      lastUpdated: meta.lastUpdated,
      dataVersion: meta.dataVersion,
    };
  }

  const cursor = query.cursor ? decodeCursor(query.cursor) : null;
  const latest = dated
    .filter((item) => query.source === 'all' || item.source === query.source)
    .filter(
      (item) =>
        !cursor ||
        item.publishedAt < cursor.p ||
        (item.publishedAt === cursor.p && item.id < cursor.id),
    )
    .sort(compareLatest);
  const items = latest.slice(0, query.limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      latest.length > query.limit && last ? encodeCursor(last) : null,
    counts,
    totals,
    lastUpdated: meta.lastUpdated,
    dataVersion: meta.dataVersion,
  };
}

export function feedQueryKey(query: FeedQuery): string {
  return JSON.stringify([
    query.view,
    query.source,
    query.from ?? null,
    query.to ?? null,
    query.limit,
    query.cursor ?? null,
  ]);
}

function beijingDayStart(now: number): number {
  const shifted = new Date(now + BEIJING_OFFSET_MS);
  return (
    Date.UTC(
      shifted.getUTCFullYear(),
      shifted.getUTCMonth(),
      shifted.getUTCDate(),
    ) - BEIJING_OFFSET_MS
  );
}

function dateWindows(now: number): Array<{ from?: number; to?: number }> {
  const today = beijingDayStart(now);
  return [
    {},
    { from: today - DAY_MS, to: today - 1 },
    { from: today - 2 * DAY_MS, to: today + DAY_MS - 1 },
    { from: today - 6 * DAY_MS, to: today + DAY_MS - 1 },
  ];
}

export function itemShard(id: string): string {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
  return String(hash >>> 0 & 7);
}

export function buildSnapshot(
  rawItems: FeedItem[],
  meta: SnapshotMeta,
  generatedAt = Date.now(),
  targetBytes = SNAPSHOT_PACK_TARGET_BYTES,
  generatorRecords?: unknown[],
): SnapshotBuild {
  const items = rawItems
    .filter((item) => !item.hidden)
    .sort(compareLatest);
  const snapshotId = `${meta.dataVersion}-${generatedAt}`;
  const artifacts: SnapshotBuild['artifacts'] = [];
  let chunks: Buffer[] = [];
  let packOffset = 0;
  const responses: Record<string, SnapshotRange> = {};
  const partKey = () => `feed/v1/artifacts/${snapshotId}/${artifacts.length}.pack`;
  const flush = () => {
    if (chunks.length === 0) return;
    const body = Buffer.concat(chunks);
    artifacts.push({ key: partKey(), body, sha256: createHash('sha256').update(body).digest('hex') });
    chunks = [];
    packOffset = 0;
  };
  const appendJson = (value: unknown): SnapshotRange => {
    const bytes = Buffer.from(JSON.stringify(value));
    if (bytes.length > 64 * 1024 * 1024) throw new Error('Snapshot record exceeds upload limit');
    if (packOffset > 0 && packOffset + bytes.length > targetBytes) flush();
    const range = { key: partKey(), offset: packOffset, length: bytes.length };
    chunks.push(bytes);
    packOffset += bytes.length;
    return range;
  };
  const sourceOptions: Array<SourceId | 'all'> = ['all', ...SOURCE_IDS];

  for (const window of dateWindows(generatedAt)) {
    for (const source of sourceOptions) {
      for (const view of ['latest', 'hot', 'rising'] as const) {
        const limit = view === 'rising' ? 50 : 30;
        let cursor: string | undefined;
        do {
          const query: FeedQuery = {
            view,
            source,
            ...(window.from !== undefined ? { from: window.from } : {}),
            ...(window.to !== undefined ? { to: window.to } : {}),
            limit,
            ...(cursor ? { cursor } : {}),
          };
          const response = buildFeedResponse(items, query, meta, generatedAt);
          responses[feedQueryKey(query)] = appendJson(response);
          cursor = view === 'latest' && response.nextCursor
            ? response.nextCursor
            : undefined;
        } while (cursor);
      }
    }
  }

  const canonicalParts: SnapshotRange[] = [];
  const indexes: Record<string, Record<string, SnapshotRange>> = {};
  const appendItems = (group: FeedItem[]) => {
    const range = appendJson(group);
    canonicalParts.push(range);
    let offset = range.offset + 1; // Opening '['; each item is a standalone JSON slice.
    for (const item of group) {
      const length = Buffer.byteLength(JSON.stringify(item));
      (indexes[itemShard(item.id)] ??= {})[item.id] = { key: range.key, offset, length };
      offset += length + 1;
    }
  };
  let group: FeedItem[] = [];
  let groupBytes = 2;
  for (const item of items) {
    const size = Buffer.byteLength(JSON.stringify(item)) + 1;
    if (group.length > 0 && groupBytes + size > CANONICAL_CHUNK_BYTES) {
      appendItems(group);
      group = [];
      groupBytes = 2;
    }
    group.push(item);
    groupBytes += size;
  }
  appendItems(group);
  const itemIndexes: Record<string, SnapshotRange> = {};
  for (const [shard, index] of Object.entries(indexes)) itemIndexes[shard] = appendJson(index);
  // Small tuples support uncommon date/limit queries without parsing bodies.
  const catalog = appendJson(items.map((item) => [
    item.id, item.source, item.publishedAt, item.fetchedAt, item.hotScore, item.isHot ? 1 : 0,
  ]));
  const generatorStateParts: SnapshotRange[] = [];
  if (generatorRecords) {
    let records: unknown[] = [], recordBytes = 2;
    for (const record of generatorRecords) {
      const length = Buffer.byteLength(JSON.stringify(record)) + 1;
      if (records.length && recordBytes + length > CANONICAL_CHUNK_BYTES) {
        generatorStateParts.push(appendJson(records)); records = []; recordBytes = 2;
      }
      records.push(record); recordBytes += length;
    }
    generatorStateParts.push(appendJson(records));
  }
  flush();
  // Leave room below the Workers Free per-request subrequest limit for ID
  // index reads, pointers and a bounded fallback.
  if (artifacts.length > 32) throw new Error('Snapshot exceeds 32 artifacts; active version retained');
  const first = artifacts[0]!;
  return {
    artifacts,
    manifest: {
      formatVersion: SNAPSHOT_FORMAT_VERSION,
      snapshotId,
      generatedAt,
      packKey: first.key,
      packSize: artifacts.reduce((sum, artifact) => sum + artifact.body.length, 0),
      packSha256: first.sha256,
      ...meta,
      artifacts: artifacts.map(({ key, body, sha256 }) => ({ key, size: body.length, sha256 })),
      canonical: canonicalParts[0]!,
      canonicalParts,
      itemIndexes,
      catalog,
      ...(generatorRecords ? { generatorStateParts } : {}),
      responses,
    },
  };
}
