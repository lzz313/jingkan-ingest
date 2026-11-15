import { deduplicateImages } from '../shared/images';
import { isUsableTranslation, translationText } from '../shared/translation';
import type { FeedItem, NormalizedItem, SourceId, SourceStatus, IngestStatus } from '../shared/types';
import { normalizeItem } from '../shared/normalize';
import { computeHot } from '../shared/scoring';
import { shouldHideItem } from '../shared/spam';
import { MODERATE_SOURCES } from '../shared/moderate';
import { sourceNeedsTitleTranslation } from '../shared/sources';
import { contentExtra } from '../shared/content-extra';

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
export interface StoredItem {
  item: FeedItem;
  observedAt: number;
  ruleHidden: boolean;
  moderation: 'keep' | 'hide' | 'pending';
  aiReason?: string;
  /** Earliest post this record duplicates; hidden while it points at one. */
  duplicateOf?: string;
  dedupe?: DedupeMarker;
}
export const STATE_RETENTION_MS = 35 * 86400000;
export interface GeneratorState {
  records: Map<string, StoredItem>;
  sources: Partial<Record<SourceId, SourceStatus>>;
  lastUpdated: number;
  lastRefreshAt: number;
  lastIngestAttemptAt: number;
}
export interface EnrichmentEntry { id: string; contentHash: string | null; field: 'titleZh' | 'briefZh' | 'bodyZh'; text: string }
export type InputEvent =
  | { kind: 'ingest'; items: NormalizedItem[]; sourceStatus?: Partial<Record<SourceId, IngestStatus>>; createdAt: number }
  | { kind: 'enrichment'; entries: EnrichmentEntry[]; createdAt: number }
  | { kind: 'maintenance'; patches: Array<{ id: string; hidden?: boolean; images?: string[] }>; createdAt: number };

export function bootstrapRecords(items: FeedItem[]): StoredItem[] {
  return items.map((item) => ({ item, observedAt: item.fetchedAt, ruleHidden: item.hidden, moderation: 'keep' }));
}
function moderated(source: SourceId): boolean { return (MODERATE_SOURCES as readonly SourceId[]).includes(source); }

export function mergeItems(state: GeneratorState, inputs: NormalizedItem[], now: number): number {
  let changes = 0;
  for (const raw of inputs) {
    let normalized: NormalizedItem;
    try { normalized = normalizeItem(raw, now); } catch { continue; }
    const id = `${normalized.source}:${normalized.externalId}`;
    const old = state.records.get(id);
    if (old && now < old.observedAt) continue;
    const edited = !old || old.item.contentHash !== normalized.contentHash;
    const hidden = Boolean(normalized.hidden || shouldHideItem(normalized));
    const hot = computeHot(normalized.source, normalized.metrics ?? {});
    const next: FeedItem = {
      id, source: normalized.source, externalId: normalized.externalId, storyKey: normalized.storyKey ?? null,
      title: normalized.title,
      titleZh: sourceNeedsTitleTranslation(normalized.source) ? normalized.titleZh ?? (edited ? null : old?.item.titleZh ?? null) : null,
      body: normalized.body || null, brief: normalized.brief || null,
      briefZh: normalized.briefZh ?? (edited ? null : old?.item.briefZh ?? null),
      bodyZh: normalized.bodyZh ?? (edited ? null : old?.item.bodyZh ?? null),
      url: old && normalized.source === 'hn' ? old.item.url : normalized.url,
      author: normalized.author ?? null, authorHandle: normalized.authorHandle ?? null,
      publishedAt: old && normalized.source !== 'github' ? old.item.publishedAt : normalized.publishedAt,
      firstSeenAt: old?.item.firstSeenAt ?? now, fetchedAt: now,
      metrics: normalized.metrics ?? {}, hotScore: hot.score, isHot: hot.isHot,
      images: normalized.images?.length ? normalized.images : old?.item.images ?? [],
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
      if (isUsableTranslation(translationText(record.item, field), entry.text)) record.item[entry.field] = entry.text;
    }
  }
  if (event.kind === 'maintenance' && Array.isArray(event.patches)) {
    for (const patch of event.patches) {
      const record = state.records.get(patch.id);
      if (!record || event.createdAt < record.observedAt) continue;
      if (typeof patch.hidden === 'boolean') { record.ruleHidden = patch.hidden; record.item.hidden = patch.hidden; }
      if (Array.isArray(patch.images)) record.item.images = deduplicateImages(patch.images, record.item.url);
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
    if (!record.ruleHidden && shouldHideItem(record.item)) {
      record.ruleHidden = true; record.item.hidden = true; hidden++;
    }
    for (const field of ['title', 'brief', 'body'] as const) {
      const target = field === 'title' ? 'titleZh' : field === 'brief' ? 'briefZh' : 'bodyZh';
      if (record.item[target] && !isUsableTranslation(translationText(record.item, field), record.item[target])) {
        record.item[target] = null; translationsReset++;
      }
    }
  }
  return { hidden, translationsReset };
}
export function pruneState(state: GeneratorState, cutoff: number): void {
  for (const [id, record] of state.records) if (record.item.publishedAt < cutoff) state.records.delete(id);
}
export function visibleItems(state: GeneratorState): FeedItem[] {
  return [...state.records.values()]
    .filter((record) => !record.ruleHidden && record.moderation === 'keep' && !record.duplicateOf)
    .map((record) => ({ ...record.item, hidden: false }));
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
/** Minutes since midnight in Beijing, independent of the runner's time zone. */
function beijingMinutes(timestamp: number): number {
  const date = new Date(timestamp + 8 * 3600000);
  return date.getUTCHours() * 60 + date.getUTCMinutes();
}
export function isSourceWindow(timestamp: number): boolean {
  const minutes = beijingMinutes(timestamp);
  // 06:00–08:00 only opens the top ten minutes of each hour: one fetch per
  // hour there, while the rest of the day keeps the ten-minute cadence.
  return [[360,370],[420,430],[510,720],[750,760],[780,1080],[1110,1120],[1140,1420]].some(([start,end]) => minutes >= start! && minutes < end!);
}
