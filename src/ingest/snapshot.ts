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
import { hotRankScore } from '../shared/scoring';

const DAY_MS = 24 * 60 * 60_000;
const BEIJING_OFFSET_MS = 8 * 60 * 60_000;
const HOT_PER_SOURCE = 5;
const RISING_PER_SOURCE = 8;
const HOT_FRESH_MS = DAY_MS;
// Re-fetching an old post refreshes `fetchedAt`; a publication window keeps it
// from resurrecting in the hot view even before decay has pushed it down.
const HOT_MAX_AGE_MS = 3 * DAY_MS;
const RISING_WINDOW_MS = DAY_MS;
const SNAPSHOT_FORMAT_VERSION = 2;
export const SNAPSHOT_PACK_TARGET_BYTES = 8 * 1024 * 1024;
const CANONICAL_CHUNK_BYTES = 256 * 1024;
const MAX_RECORD_BYTES = 64 * 1024 * 1024;
const HOT_LIMIT = 30;
const LATEST_LIMIT = 30;
const RISING_LIMIT = 50;
/**
 * Deep latest pages are served on demand by the Worker from the catalog and
 * item indexes. Packing them here only inflates the snapshot and pushes it
 * toward the per-request artifact limit.
 */
const PRECOMPUTED_LATEST_PAGES = 3;
const OPEN_BRACKET = Buffer.from('[');
const CLOSE_BRACKET = Buffer.from(']');
const COMMA = Buffer.from(',');

export interface SnapshotMeta {
  lastIngestAttemptAt?: number;
  processedEvents?: string[];
  removed?: Record<string, number>;
  /** Resume point for the paginated `feed/enrichment/` retention sweep. */
  enrichmentCleanupCursor?: string | null;
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

interface RankedPool {
  bySource: Map<string, FeedItem[]>;
  items: FeedItem[];
  total: number;
}

/**
 * Deterministic UTF-16 code-unit order. `localeCompare` can disagree between
 * Node and the Worker/browser, which would make cursor pages drop or repeat
 * items whose publication times tie.
 */
function compareIds(a: string, b: string): number {
  return a === b ? 0 : b > a ? 1 : -1;
}

function compareLatest(a: FeedItem, b: FeedItem): number {
  return b.publishedAt - a.publishedAt || compareIds(a.id, b.id);
}

function compareRanked(a: FeedItem, b: FeedItem, now: number): number {
  return (
    hotRankScore(b.hotScore, b.publishedAt, now) -
      hotRankScore(a.hotScore, a.publishedAt, now) ||
    compareLatest(a, b)
  );
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
  query: Pick<FeedQuery, 'from' | 'to'>,
  now: number,
): RankedPool {
  const risingFrom =
    query.from ??
    (query.to !== undefined ? query.to - RISING_WINDOW_MS : now - RISING_WINDOW_MS);
  const groups = new Map<string, FeedItem[]>();
  for (const item of items) {
    if (item.hotEligible === false) continue;
    if (view === 'hot') {
      if (item.fetchedAt < now - HOT_FRESH_MS) continue;
      if (item.publishedAt < now - HOT_MAX_AGE_MS) continue;
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
    const top = group.sort((a, b) => compareRanked(a, b, now)).slice(0, perSource);
    bySource.set(source, top);
    ranked.push(...top);
    total += top.length;
  }
  ranked.sort((a, b) => compareRanked(a, b, now));
  return { bySource, items: ranked, total };
}

/** Source counts for a ranked view, mirroring buildFeedResponse. */
function rankedCounts(ranked: RankedPool): SourceCounts {
  const bySource: Partial<Record<SourceId, number>> = {};
  let all = 0;
  for (const [source, group] of ranked.bySource) {
    if (!isSourceId(source)) continue;
    bySource[source] = group.length;
    all += group.length;
  }
  return { all, bySource };
}

export function buildFeedResponse(
  snapshotItems: FeedItem[],
  query: FeedQuery,
  meta: Pick<SnapshotMeta, 'lastUpdated' | 'dataVersion'>,
  now: number,
): FeedResponse {
  // Merged cross-source copies stay in canonical output for item lookup, but
  // never occupy a feed slot, a count or a ranking position.
  const feedItems = snapshotItems.filter((item) => !item.clusterOf);
  const hot = rankedPool(feedItems, 'hot', query, now);
  const rising = rankedPool(feedItems, 'rising', query, now);
  const totals = { hot: hot.total, rising: rising.total };
  const dated = feedItems.filter((item) => inRange(item, query.from, query.to));
  const countsBySource: Partial<Record<SourceId, number>> = {};
  for (const item of dated) {
    countsBySource[item.source] = (countsBySource[item.source] ?? 0) + 1;
  }
  const counts: SourceCounts = { all: dated.length, bySource: countsBySource };

  if (query.view === 'hot' || query.view === 'rising') {
    const ranked = query.view === 'hot' ? hot : rising;
    return {
      items: ranked.items
        .filter((item) => query.source === 'all' || item.source === query.source)
        .slice(0, query.limit),
      nextCursor: null,
      counts: rankedCounts(ranked),
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

interface SerializedItem {
  item: FeedItem;
  bytes: Buffer;
}

/** Everything a window needs, computed from the snapshot once. */
interface WindowData {
  counts: SourceCounts;
  totals: { hot: number; rising: number };
  ranked: Record<'hot' | 'rising', { items: FeedItem[]; bySource: Map<string, FeedItem[]>; counts: SourceCounts }>;
  latestBySource: Map<string, FeedItem[]>;
}

function windowData(feedItems: FeedItem[], window: { from?: number; to?: number }, now: number): WindowData {
  const dated = feedItems.filter((item) => inRange(item, window.from, window.to));
  const countsBySource: Partial<Record<SourceId, number>> = {};
  for (const item of dated) {
    countsBySource[item.source] = (countsBySource[item.source] ?? 0) + 1;
  }

  const hot = rankedPool(feedItems, 'hot', window, now);
  const rising = rankedPool(feedItems, 'rising', window, now);

  // Sort the dated list once, then split it per source by a single pass:
  // buildFeedResponse used to re-filter and re-sort the whole snapshot for
  // every source/view/window combination.
  const latest = dated.slice().sort(compareLatest);
  const latestBySource = new Map<string, FeedItem[]>([['all', latest]]);
  for (const item of latest) {
    const list = latestBySource.get(item.source);
    if (list) list.push(item);
    else latestBySource.set(item.source, [item]);
  }

  return {
    counts: { all: dated.length, bySource: countsBySource },
    totals: { hot: hot.total, rising: rising.total },
    ranked: {
      hot: { items: hot.items, bySource: hot.bySource, counts: rankedCounts(hot) },
      rising: { items: rising.items, bySource: rising.bySource, counts: rankedCounts(rising) },
    },
    latestBySource,
  };
}

/** Serialized canonical items, reused for both packing and exact byte ranges. */
function serializeItems(items: FeedItem[]): SerializedItem[] {
  return items.map((item) => ({ item, bytes: Buffer.from(JSON.stringify(item)) }));
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
  const appendBytes = (bytes: Buffer): SnapshotRange => {
    if (bytes.length > MAX_RECORD_BYTES) throw new Error('Snapshot record exceeds upload limit');
    if (packOffset > 0 && packOffset + bytes.length > targetBytes) flush();
    const range = { key: partKey(), offset: packOffset, length: bytes.length };
    chunks.push(bytes);
    packOffset += bytes.length;
    return range;
  };
  const appendJson = (value: unknown): SnapshotRange => appendBytes(Buffer.from(JSON.stringify(value)));
  const sourceOptions: Array<SourceId | 'all'> = ['all', ...SOURCE_IDS];
  const feedItems = items.filter((item) => !item.clusterOf);

  for (const window of dateWindows(generatedAt)) {
    const data = windowData(feedItems, window, generatedAt);
    const range = {
      ...(window.from !== undefined ? { from: window.from } : {}),
      ...(window.to !== undefined ? { to: window.to } : {}),
    };
    for (const source of sourceOptions) {
      const hotItems = source === 'all' ? data.ranked.hot.items : data.ranked.hot.bySource.get(source) ?? [];
      const risingItems = source === 'all' ? data.ranked.rising.items : data.ranked.rising.bySource.get(source) ?? [];
      const common = {
        nextCursor: null,
        totals: data.totals,
        lastUpdated: meta.lastUpdated,
        dataVersion: meta.dataVersion,
      };
      responses[feedQueryKey({ view: 'hot', source, ...range, limit: HOT_LIMIT })] = appendJson({
        items: hotItems.slice(0, HOT_LIMIT), counts: data.ranked.hot.counts, ...common,
      });
      responses[feedQueryKey({ view: 'rising', source, ...range, limit: RISING_LIMIT })] = appendJson({
        items: risingItems.slice(0, RISING_LIMIT), counts: data.ranked.rising.counts, ...common,
      });

      const list = data.latestBySource.get(source) ?? [];
      let pageCursor: Cursor | null = null;
      let cursorString: string | null = null;
      for (let page = 0; page < PRECOMPUTED_LATEST_PAGES; page++) {
        const start = pageCursor
          ? list.findIndex(
            (item) =>
              item.publishedAt < pageCursor!.p ||
              (item.publishedAt === pageCursor!.p && item.id < pageCursor!.id),
          )
          : 0;
        if (start < 0) break;
        const pageItems = list.slice(start, start + LATEST_LIMIT);
        const last = pageItems.at(-1);
        const nextCursor = list.length > start + LATEST_LIMIT && last ? encodeCursor(last) : null;
        const query: FeedQuery = {
          view: 'latest',
          source,
          ...range,
          limit: LATEST_LIMIT,
          ...(cursorString ? { cursor: cursorString } : {}),
        };
        responses[feedQueryKey(query)] = appendJson({
          items: pageItems,
          nextCursor,
          counts: data.counts,
          totals: data.totals,
          lastUpdated: meta.lastUpdated,
          dataVersion: meta.dataVersion,
        });
        if (!nextCursor || !last) break;
        cursorString = nextCursor;
        pageCursor = { p: last.publishedAt, h: last.hotScore, id: last.id };
      }
    }
  }

  const canonicalParts: SnapshotRange[] = [];
  const indexes: Record<string, Record<string, SnapshotRange>> = {};
  const appendCanonicalGroup = (group: SerializedItem[]) => {
    const buffers: Buffer[] = [OPEN_BRACKET];
    for (const [index, entry] of group.entries()) {
      if (index > 0) buffers.push(COMMA);
      buffers.push(entry.bytes);
    }
    buffers.push(CLOSE_BRACKET);
    const range = appendBytes(Buffer.concat(buffers));
    canonicalParts.push(range);
    let offset = range.offset + 1; // Opening '['; each item is a standalone JSON slice.
    for (const entry of group) {
      (indexes[itemShard(entry.item.id)] ??= {})[entry.item.id] = {
        key: range.key,
        offset,
        length: entry.bytes.length,
      };
      offset += entry.bytes.length + 1;
    }
  };
  let group: SerializedItem[] = [];
  let groupBytes = 2;
  for (const entry of serializeItems(items)) {
    const size = entry.bytes.length + 1;
    if (group.length > 0 && groupBytes + size > CANONICAL_CHUNK_BYTES) {
      appendCanonicalGroup(group);
      group = [];
      groupBytes = 2;
    }
    group.push(entry);
    groupBytes += size;
  }
  if (group.length > 0) appendCanonicalGroup(group);
  // An empty snapshot still needs a valid `[]` canonical block.
  else if (canonicalParts.length === 0) appendCanonicalGroup([]);
  const itemIndexes: Record<string, SnapshotRange> = {};
  for (const [shard, index] of Object.entries(indexes)) itemIndexes[shard] = appendJson(index);
  // Small tuples support uncommon date/limit queries without parsing bodies.
  const catalog = appendJson(items.map((item) => [
    item.id, item.source, item.publishedAt, item.fetchedAt, item.hotScore, item.isHot ? 1 : 0,
    item.clusterOf ?? '', item.hotEligible === false ? 0 : 1,
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
