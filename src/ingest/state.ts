import { deduplicateImages } from '../shared/images';
import { isChineseBrief, isUsableTranslation, translationText } from '../shared/translation';
import type { FeedItem, ItemExtra, NormalizedItem, RelatedItem, SourceId, SourceStatus, IngestStatus } from '../shared/types';
import { normalizeItem } from '../shared/normalize';
import { computeHot } from '../shared/scoring';
import { shouldHideItem } from '../shared/spam';
import { MODERATE_SOURCES } from '../shared/moderate';
import { sourceNeedsTitleTranslation } from '../shared/sources';
import { contentExtra } from '../shared/content-extra';
import { DEFAULT_X_TRUSTED_HANDLES, xHotEligible } from '../shared/x-quality';

// The canonical Beijing-time schedule is shared with the Worker watchdog.
export { isSourceWindow } from '../shared/time-window';

/** Private evidence behind a duplicate verdict; never published to feed items. */
export interface DedupeMarker {
  /** The item contentHash that was checked. */
  hash: string | null;
  /** Fingerprint of every setting that can change the verdict. */
  config: string;
  checkedAt: number;
  model?: string;
  /** Best lexical candidate, kept for debugging. */
  candidateId?: string;
  lexical?: number;
  cosine?: number;
  /** The canonical's contentHash when the duplicate was marked. */
  canonicalHash?: string | null;
}
/** Private evidence behind a cross-source merge; never published. */
export interface ClusterMarker {
  /** The item contentHash that was checked. */
  hash: string | null;
  /** Fingerprint of every setting that can change the verdict. */
  config: string;
  checkedAt: number;
  model?: string;
  /** Best candidate, kept for debugging. */
  candidateId?: string;
  lexical?: number;
  cosine?: number;
  /** Shared article/discussion URL that confirmed the merge without embeddings. */
  sharedUrl?: string;
  /** The root's contentHash when the merge was marked. */
  canonicalHash?: string | null;
}
export interface StoredItem {
  item: FeedItem;
  observedAt: number;
  ruleHidden: boolean;
  moderation: 'keep' | 'hide' | 'pending';
  aiReason?: string;
  /** The operator set visibility explicitly; source policy and merges must not undo it. */
  manualHidden?: boolean;
  /** The operator curated the image list; later fetches must not replace it. */
  manualImages?: boolean;
  /** Earliest post this record duplicates; hidden while it points at one. */
  duplicateOf?: string;
  dedupe?: DedupeMarker;
  /** Root card this record is merged into; still resolvable for favourites. */
  clusterOf?: string;
  cluster?: ClusterMarker;
}
export const STATE_RETENTION_MS = 35 * 86400000;
export interface GeneratorState {
  records: Map<string, StoredItem>;
  sources: Partial<Record<SourceId, SourceStatus>>;
  lastUpdated: number;
  lastRefreshAt: number;
  lastIngestAttemptAt: number;
  /** Resume point for the paginated `feed/enrichment/` retention sweep. */
  enrichmentCleanupCursor?: string | null;
}
export interface EnrichmentEntry { id: string; contentHash: string | null; field: 'titleZh' | 'briefZh' | 'bodyZh'; text: string }
export type InputEvent =
  | { kind: 'ingest'; items: NormalizedItem[]; sourceStatus?: Partial<Record<SourceId, IngestStatus>>; createdAt: number }
  | { kind: 'enrichment'; entries: EnrichmentEntry[]; createdAt: number }
  | { kind: 'maintenance'; patches: Array<{ id: string; hidden?: boolean; images?: string[] }>; createdAt: number };

export function bootstrapRecords(items: FeedItem[]): StoredItem[] {
  return items.map((published) => {
    // related/clusterOf/hotEligible are derived from the current merge graph
    // and quality policy, not source fields; keeping them would freeze one
    // snapshot's view into private state.
    const { related: _related, clusterOf: _clusterOf, hotEligible: _hotEligible, ...item } = published;
    return { item, observedAt: item.fetchedAt, ruleHidden: item.hidden, moderation: 'keep' };
  });
}
function moderated(source: SourceId): boolean { return (MODERATE_SOURCES as readonly SourceId[]).includes(source); }

/** True when metrics/text came from X's own syndication payload rather than the aggregator card. */
function isSyndicationEnriched(extra: ItemExtra): boolean {
  return extra.provider === 'x-syndication' || extra.statsSource === 'x-syndication';
}

/**
 * A record whose body was captured from the full source payload. A later
 * degraded fetch (Reader proxy, or Tech Twitter without syndication) must not
 * shrink it back to a headline.
 */
function isEnrichedRecord(item: FeedItem): boolean {
  const extra = item.extra ?? {};
  return isSyndicationEnriched(extra) || (extra.timeSource === 'rss' && extra.proxy !== 'jina');
}

/** A fallback fetch path known to carry less text and fewer metrics than the original. */
function isDegradedFetch(extra: ItemExtra): boolean {
  if (extra.proxy === 'jina') return true;
  return extra.provider === 'tech-twitter' && !isSyndicationEnriched(extra);
}

export function mergeItems(state: GeneratorState, inputs: NormalizedItem[], now: number): number {
  let changes = 0;
  for (const raw of inputs) {
    let normalized: NormalizedItem;
    try { normalized = normalizeItem(raw, now); } catch { continue; }
    const id = `${normalized.source}:${normalized.externalId}`;
    const old = state.records.get(id);
    if (old && now < old.observedAt) continue;
    // Keep the richer body/metrics/translations when a provider falls back to
    // a degraded path for content that was already fully captured.
    const downgraded = Boolean(old && isEnrichedRecord(old.item) && isDegradedFetch(normalized.extra ?? {}));
    const edited = !old || (!downgraded && old.item.contentHash !== normalized.contentHash);
    const hidden = old?.manualHidden ? old.item.hidden : Boolean(normalized.hidden || shouldHideItem(normalized));
    const hot = computeHot(normalized.source, normalized.metrics ?? {});
    const next: FeedItem = {
      id, source: normalized.source, externalId: normalized.externalId, storyKey: normalized.storyKey ?? null,
      title: normalized.title,
      titleZh: downgraded ? old!.item.titleZh
        : sourceNeedsTitleTranslation(normalized.source) ? normalized.titleZh ?? (edited ? null : old?.item.titleZh ?? null) : null,
      body: downgraded ? old!.item.body : normalized.body || null,
      brief: downgraded ? old!.item.brief : normalized.brief || null,
      briefZh: downgraded ? old!.item.briefZh : normalized.briefZh ?? (edited ? null : old?.item.briefZh ?? null),
      bodyZh: downgraded ? old!.item.bodyZh : normalized.bodyZh ?? (edited ? null : old?.item.bodyZh ?? null),
      url: old && normalized.source === 'hn' ? old.item.url : normalized.url,
      author: downgraded ? old!.item.author : normalized.author ?? null,
      authorHandle: downgraded ? old!.item.authorHandle : normalized.authorHandle ?? null,
      publishedAt: old && normalized.source !== 'github' ? old.item.publishedAt : normalized.publishedAt,
      firstSeenAt: old?.item.firstSeenAt ?? now, fetchedAt: now,
      metrics: downgraded ? old!.item.metrics : normalized.metrics ?? {}, hotScore: hot.score, isHot: hot.isHot,
      images: old?.manualImages ? old.item.images
        : downgraded ? old!.item.images
        : normalized.images?.length ? normalized.images : old?.item.images ?? [],
      extra: normalized.extra ?? {}, hidden, contentHash: normalized.contentHash ?? null,
    };
    const stable = (item: FeedItem) => JSON.stringify([
      item.storyKey, item.title, item.titleZh, item.body, item.brief, item.briefZh, item.bodyZh,
      item.url, item.author, item.authorHandle, item.publishedAt, item.images, item.hidden,
      item.contentHash, contentExtra(item.source, item.extra),
    ]);
    const changed = !old || stable(old.item) !== stable(next) || old.item.isHot !== next.isHot || now - old.item.fetchedAt >= 3600000;
    if (changed) {
      state.records.set(id, { item: next, ruleHidden: hidden, observedAt: now,
        moderation: edited ? moderated(next.source) ? 'pending' : 'keep' : old!.moderation,
        ...(!edited && old?.aiReason ? { aiReason: old.aiReason } : {}),
        ...(!edited && old?.duplicateOf ? { duplicateOf: old.duplicateOf } : {}),
        ...(!edited && old?.dedupe ? { dedupe: old.dedupe } : {}),
        ...(!edited && old?.clusterOf ? { clusterOf: old.clusterOf } : {}),
        ...(!edited && old?.cluster ? { cluster: old.cluster } : {}),
        ...(old?.manualHidden ? { manualHidden: true } : {}),
        ...(old?.manualImages ? { manualImages: true } : {}),
      });
      changes++;
    } else {
      old.observedAt = now;
    }
  }
  return changes;
}
export function applyEvent(state: GeneratorState, event: InputEvent): void {
  if (event.kind === 'ingest' && Array.isArray(event.items)) {
    mergeItems(state, event.items, event.createdAt);
    updateSources(state, event.sourceStatus ?? {}, event.createdAt);
    return;
  }
  if (event.kind === 'enrichment' && Array.isArray(event.entries)) {
    for (const entry of event.entries) {
      const record = state.records.get(entry.id);
      if (!record || record.item.contentHash !== entry.contentHash || !['titleZh', 'briefZh', 'bodyZh'].includes(entry.field) || typeof entry.text !== 'string') continue;
      if (entry.field === 'titleZh' && !sourceNeedsTitleTranslation(record.item.source)) continue;
      const field = entry.field === 'titleZh' ? 'title' : entry.field === 'briefZh' ? 'brief' : 'body';
      // A brief is the Chinese key-point row; model meta-notes and a bare 无
      // are not summaries and must never be stored as one.
      const usable = entry.field === 'briefZh'
        ? isChineseBrief(entry.text)
        : isUsableTranslation(translationText(record.item, field), entry.text);
      if (usable) record.item[entry.field] = entry.text;
    }
  }
  if (event.kind === 'maintenance' && Array.isArray(event.patches)) {
    for (const patch of event.patches) {
      const record = state.records.get(patch.id);
      if (!record || event.createdAt < record.observedAt) continue;
      if (typeof patch.hidden === 'boolean') {
        record.ruleHidden = patch.hidden;
        record.item.hidden = patch.hidden;
        // Operator visibility is sticky: neither policy reconciliation nor a
        // later fetch may silently flip it back.
        record.manualHidden = true;
      }
      if (Array.isArray(patch.images)) {
        record.item.images = deduplicateImages(patch.images, record.item.url);
        record.manualImages = true;
      }
    }
  }
}
export function updateSources(state: GeneratorState, status: Partial<Record<SourceId, IngestStatus>>, now: number): void {
  for (const [key, value] of Object.entries(status)) {
    const source = key as SourceId;
    if (!value || (state.sources[source]?.lastUpdated ?? 0) > now) continue;
    state.sources[source] = { ok: value.ok, lastUpdated: now, ...(value.error ? { lastError: value.error } : {}) };
  }
  if (Object.values(status).some((entry) => entry?.ok && (entry.count ?? 0) > 0)) state.lastUpdated = Math.max(state.lastUpdated, now);
}
/** Repair retained image lists without changing source freshness or content hashes. */
export function deduplicateStateImages(state: GeneratorState): number {
  let changed = 0;
  for (const record of state.records.values()) {
    const images = deduplicateImages(record.item.images, record.item.url);
    if (JSON.stringify(images) !== JSON.stringify(record.item.images)) {
      record.item.images = images; changed++;
    }
  }
  return changed;
}

/** Apply current policy to retained records too, including posts no longer returned by a source. */
export function reconcileState(state: GeneratorState): { hidden: number; translationsReset: number } {
  let hidden = 0, translationsReset = 0;
  for (const record of state.records.values()) {
    if (!record.ruleHidden && !record.manualHidden && shouldHideItem(record.item)) {
      record.ruleHidden = true; record.item.hidden = true; hidden++;
    }
    for (const field of ['title', 'brief', 'body'] as const) {
      const target = field === 'title' ? 'titleZh' : field === 'brief' ? 'briefZh' : 'bodyZh';
      const usable = field === 'brief'
        ? isChineseBrief(record.item[target])
        : isUsableTranslation(translationText(record.item, field), record.item[target]);
      if (record.item[target] && !usable) {
        record.item[target] = null; translationsReset++;
      }
    }
  }
  return { hidden, translationsReset };
}
export function pruneState(state: GeneratorState, cutoff: number): void {
  for (const [id, record] of state.records) if (record.item.publishedAt < cutoff) state.records.delete(id);
}
/** One link per source, oldest first: a source with two merged posts still gets one link. */
function relatedItems(children: StoredItem[] | undefined): RelatedItem[] {
  if (!children?.length) return [];
  const bySource = new Map<SourceId, StoredItem>();
  for (const child of children) {
    const current = bySource.get(child.item.source);
    if (!current || child.item.publishedAt < current.item.publishedAt) {
      bySource.set(child.item.source, child);
    }
  }
  return [...bySource.values()]
    .sort((a, b) => a.item.publishedAt - b.item.publishedAt || a.item.id.localeCompare(b.item.id))
    .map(({ item }) => ({
      id: item.id, source: item.source, title: item.title, titleZh: item.titleZh,
      url: item.url, author: item.author, publishedAt: item.publishedAt,
    }));
}

export interface VisibleItemOptions {
  /** Overrides the curated X allowlist; unset keeps the defaults. */
  trustedXHandles?: ReadonlySet<string>;
  /** Set false to roll the X hot-view gate back; unset keeps it enabled. */
  hotGateEnabled?: boolean;
}

/**
 * Every item that stays resolvable in the snapshot, including merged
 * cross-source duplicates. Feed builders filter `clusterOf`; item lookup does
 * not, so a favourite never disappears when its story is merged.
 */
export function visibleItems(
  state: GeneratorState,
  options: VisibleItemOptions = {},
): FeedItem[] {
  const trustedXHandles = options.trustedXHandles ?? DEFAULT_X_TRUSTED_HANDLES;
  const children = new Map<string, StoredItem[]>();
  for (const record of state.records.values()) {
    if (!record.clusterOf || record.ruleHidden || record.moderation !== 'keep' || record.duplicateOf) continue;
    const list = children.get(record.clusterOf) ?? [];
    list.push(record);
    children.set(record.clusterOf, list);
  }
  return [...state.records.values()]
    .filter((record) => !record.ruleHidden && record.moderation === 'keep' && !record.duplicateOf)
    .map((record) => {
      const { related: _related, clusterOf: _clusterOf, hotEligible: _hotEligible, ...base } = record.item;
      const item: FeedItem = { ...base, hidden: false };
      if (record.clusterOf) item.clusterOf = record.clusterOf;
      const related = relatedItems(children.get(item.id));
      if (related.length) item.related = related;
      if (item.source === 'x' && options.hotGateEnabled !== false) {
        item.hotEligible = xHotEligible(item, related.length, trustedXHandles);
      }
      return item;
    });
}
export function removedItems(state: GeneratorState): Record<string, number> {
  return Object.fromEntries([...state.records.values()]
    .filter((record) => record.ruleHidden || record.moderation === 'hide' || record.duplicateOf)
    .map((record) => [record.item.id, record.item.publishedAt]));
}
/** Records that may consume moderation or translation budget. */
export function enrichmentRecords(state: GeneratorState): StoredItem[] {
  return [...state.records.values()].filter((record) => !record.ruleHidden && !record.duplicateOf);
}
/**
 * Release pointers whose canonical stopped being a valid root. A pruned
 * canonical is deliberately kept: the duplicate ages out with it, and clearing
 * the pointer would resurrect an old post into the feed.
 */
export function reconcileDuplicatePointers(state: GeneratorState): number {
  let cleared = 0;
  for (const record of state.records.values()) {
    if (!record.duplicateOf) continue;
    const canonical = state.records.get(record.duplicateOf);
    if (!canonical) continue;
    const canonicalEdited = record.dedupe?.canonicalHash !== undefined &&
      record.dedupe.canonicalHash !== canonical.item.contentHash;
    if (canonical.ruleHidden || canonical.moderation === 'hide' || canonicalEdited) {
      delete record.duplicateOf;
      delete record.dedupe;
      cleared++;
    }
  }
  return cleared;
}
/**
 * Release cluster pointers whose root is gone or no longer usable. Unlike a
 * same-source duplicate, a pruned root must release its newer children:
 * keeping the pointer would hide the only remaining copy of the story.
 */
export function reconcileClusterPointers(state: GeneratorState): number {
  let cleared = 0;
  for (const record of state.records.values()) {
    if (!record.clusterOf) continue;
    const root = state.records.get(record.clusterOf);
    const edited = record.cluster?.canonicalHash !== undefined &&
      record.cluster.canonicalHash !== root?.item.contentHash;
    if (!root || root.ruleHidden || root.moderation !== 'keep' || root.duplicateOf || edited) {
      delete record.clusterOf;
      delete record.cluster;
      cleared++;
    }
  }
  return cleared;
}
/**
 * Merge removals with the new snapshot, dropping entries for records that are
 * visible again and entries past retention. Records that disappeared from
 * state stay removed until their timestamp ages out.
 */
export function reconcileRemovedMap(base: Record<string, number>, state: GeneratorState, now: number): Record<string, number> {
  const removed = { ...base, ...removedItems(state) };
  const cutoff = now - STATE_RETENTION_MS;
  for (const [id, timestamp] of Object.entries(removed)) {
    if (timestamp < cutoff) { delete removed[id]; continue; }
    const record = state.records.get(id);
    if (record && !record.ruleHidden && record.moderation === 'keep' && !record.duplicateOf) delete removed[id];
  }
  return removed;
}
