import { randomUUID } from 'node:crypto';
import { beijingDate } from '../shared/daily';
import type { FeedItem, TranslateField } from '../shared/types';
import { itemNeedsTranslation } from '../shared/translation';
import type { IngestConfig } from './env';
import { call, post, readBase, readBaseItems, readBaseRecords, uploadSnapshot } from './snapshot-client';
import { buildSnapshot } from './snapshot';
import { fetchSources } from './sources';
import { publishDailyDigests } from './daily';
import { applyEvent, bootstrapRecords, enrichmentRecords, isSourceWindow, mergeItems, deduplicateStateImages, pruneState, reconcileClusterPointers, reconcileDuplicatePointers, reconcileRemovedMap, reconcileState, sourcesWithLatestItemAt, updateSources, visibleItems, STATE_RETENTION_MS,
  type EnrichmentEntry, type GeneratorState, type InputEvent, type StoredItem } from './state';
import { runNodeSeekDedupe } from './dedupe';
import { runCrossSourceClusters } from './cluster';

interface LeaseState { lease: { token: string; expiresAt: number }; lastRefreshAt: number }
export interface PublishOptions { repackOnly?: boolean; forceFetch?: boolean; translationLimit?: number }
async function pendingEvents(config: IngestConfig): Promise<Array<{ key: string; event: InputEvent }>> {
  const keys: string[] = [];
  let cursor: string | null = null;
  do {
    const page: { keys: string[]; cursor: string | null } = await (await call(config, '/api/admin/events' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''))).json() as { keys: string[]; cursor: string | null };
    keys.push(...page.keys); cursor = page.cursor;
  } while (cursor && keys.length < 1000);
  const events: Array<{ key: string; event: InputEvent }> = [];
  for (let offset = 0; offset < keys.length; offset += 4) {
    events.push(...await Promise.all(keys.slice(offset, offset + 4).map(async (key) => ({
      key, event: await (await call(config, '/api/admin/events?key=' + encodeURIComponent(key))).json() as InputEvent,
    }))));
  }
  return events.sort((a, b) => a.event.createdAt - b.event.createdAt || a.key.localeCompare(b.key));
}
/** Rotate sources and alternate newest/oldest so fresh traffic cannot starve backlog. */
export function selectBacklog(items: FeedItem[], limit: number): FeedItem[] {
  const groups = new Map<string, FeedItem[]>();
  for (const item of items) {
    const group = groups.get(item.source) ?? []; group.push(item); groups.set(item.source, group);
  }
  const selected: FeedItem[] = [];
  for (let round = 0; selected.length < limit; round++) {
    let progress = false;
    for (const group of groups.values()) {
      const item = round % 2 === 0 ? group.shift() : group.pop();
      if (item) { selected.push(item); progress = true; }
      if (selected.length === limit) break;
    }
    if (!progress) break;
  }
  return selected;
}
/**
 * Moderate one batch. A batch-level failure may be caused by a single
 * un-moderatable item, so split it in half and retry down to one item instead
 * of abandoning every later batch in the run.
 */
async function moderateBatch(config: IngestConfig, state: GeneratorState, items: FeedItem[]): Promise<number> {
  if (!items.length) return 0;
  try {
    const result = await post<{ moderation: Array<{ id: string; contentHash: string | null; hide: boolean; reason: string | null }> }>(config, '/api/admin/enrich', { kind: 'moderate', items });
    let applied = 0;
    for (const decision of result.moderation ?? []) {
      const record = state.records.get(decision.id);
      if (record?.item.contentHash !== decision.contentHash || typeof decision.hide !== 'boolean') continue;
      record.moderation = decision.hide ? 'hide' : 'keep'; record.aiReason = decision.reason ?? undefined;
      applied++;
    }
    console.log(`[publish] moderated ${result.moderation?.length ?? 0} candidates`);
    return applied;
  } catch (error) {
    if (items.length === 1) {
      console.warn(`[publish] moderation skipped ${items[0]!.id}:`, String(error));
      return 0;
    }
    const middle = Math.ceil(items.length / 2);
    return await moderateBatch(config, state, items.slice(0, middle)) +
      await moderateBatch(config, state, items.slice(middle));
  }
}
async function enrich(config: IngestConfig, state: GeneratorState, translationLimit = 60): Promise<number> {
  let applied = 0;
  const records = enrichmentRecords(state).sort((a, b) => b.item.publishedAt - a.item.publishedAt);
  const pending = selectBacklog(records.filter((record) => record.moderation === 'pending').map((r) => r.item), 60);
  for (let offset = 0; offset < pending.length; offset += 20) {
    applied += await moderateBatch(config, state, pending.slice(offset, offset + 20));
  }
  if (!config.prewarmTranslations) return applied;
  // Merged copies are not shown; skip their translation budget until they
  // are released (a released copy is picked up again on the next run).
  const visible = records
    .filter((record) => record.moderation === 'keep' && !record.clusterOf)
    .map((r) => r.item);
  const tasks: Array<{ field: TranslateField; items: FeedItem[] }> = [
    { field: 'title', items: selectBacklog(visible.filter((item) => itemNeedsTranslation(item, 'title')), translationLimit) },
    { field: 'brief', items: selectBacklog(visible.filter((item) => itemNeedsTranslation(item, 'brief')), 30) },
    { field: 'body', items: selectBacklog(visible.filter((item) => itemNeedsTranslation(item, 'body')), 20) },
  ];
  for (const task of tasks) {
    for (let offset = 0; offset < task.items.length; offset += 10) {
      try {
        const result = await post<{ entries: EnrichmentEntry[] }>(config, '/api/admin/enrich', { kind: 'translate', field: task.field, items: task.items.slice(offset, offset + 10) });
        applyEvent(state, { kind: 'enrichment', entries: result.entries, createdAt: Date.now() });
        applied += result.entries.length;
        console.log(`[publish] ${task.field}: ${result.entries.length} translations`);
        if (!result.entries.length) break;
      } catch (error) { console.warn(`[publish] ${task.field} pending:`, String(error)); break; }
    }
  }
  return applied;
}
export async function runPublisher(config: IngestConfig, options: PublishOptions = {}): Promise<void> {
  const owner = `${process.env.GITHUB_RUN_ID ?? 'local'}:${process.env.GITHUB_RUN_ATTEMPT ?? '1'}:${randomUUID()}`;
  const claimed = await post<LeaseState>(config, '/api/admin/publisher', { action: 'claim', owner });
  const token = claimed.lease.token;
  let lostLease = false;
  let renewal: Promise<void> = Promise.resolve();
  const timer = setInterval(() => {
    renewal = renewal.then(async () => {
      try {
        await post(config, '/api/admin/publisher', { action: 'renew', token });
        // A transient outage is not a lost lease: keep publishing unless the
        // Worker explicitly rejected this token.
        lostLease = false;
      } catch (error) {
        const message = String(error);
        if (/\b409\b/.test(message)) { lostLease = true; console.error('[publish] lease lost', message); }
        else console.warn('[publish] lease renewal deferred:', message);
      }
    });
  }, 60000);
  try {
    const base = await readBase(config);
    const bootstrapped = !base.generatorStateParts;
    const records = base.generatorStateParts
      ? await readBaseRecords<StoredItem>(config, base, base.generatorStateParts)
      : bootstrapRecords(await readBaseItems(config, base));
    const state: GeneratorState = { records: new Map(records.map((r) => [r.item.id, r])), sources: base.sources,
      lastUpdated: base.lastUpdated, lastRefreshAt: Math.max(base.lastRefreshAt, claimed.lastRefreshAt), lastIngestAttemptAt: base.lastIngestAttemptAt ?? 0,
      enrichmentCleanupCursor: base.enrichmentCleanupCursor ?? null };
    console.log(`[publish] loaded ${records.length} records from ${bootstrapped ? 'public R2 bootstrap' : 'private state'}`);
    const events = options.repackOnly ? [] : await pendingEvents(config);
    let stateMutated = events.length > 0;
    for (const { event } of events) applyEvent(state, event);
    const now = Date.now();
    const shouldFetch = !options.repackOnly && (options.forceFetch || claimed.lastRefreshAt > state.lastIngestAttemptAt || (isSourceWindow(now) && now - state.lastIngestAttemptAt >= 600000));
    if (shouldFetch) {
      state.lastIngestAttemptAt = now;
      const fetched = await fetchSources(now);
      if (mergeItems(state, fetched.items, now) > 0) stateMutated = true;
      updateSources(state, fetched.sourceStatus, now);
    }
    const imageRepairs = deduplicateStateImages(state);
    if (imageRepairs) { stateMutated = true; console.log(`[publish] deduplicated images in ${imageRepairs} records`); }
    if (!options.repackOnly) {
      const retained = state.records.size;
      pruneState(state, now - STATE_RETENTION_MS);
      if (state.records.size !== retained) stateMutated = true;
      const reconciled = reconcileState(state);
      if (reconciled.hidden || reconciled.translationsReset) stateMutated = true;
      console.log('[publish] policy reconciliation:', JSON.stringify(reconciled));
      const released = reconcileDuplicatePointers(state);
      if (released) { stateMutated = true; console.log(`[publish] released ${released} stale duplicate pointers`); }
      try {
        const dedupe = await runNodeSeekDedupe(config, state, now);
        if (!dedupe.dryRun && (dedupe.checked || dedupe.reset)) stateMutated = true;
        if (dedupe.reset) console.log('[publish] duplicate markers reset');
        else if (dedupe.checked) console.log(`[publish] dedupe checked ${dedupe.checked}, ${dedupe.dryRun ? 'would hide' : 'hid'} ${dedupe.duplicates}, deferred ${dedupe.skipped}`);
      } catch (error) { console.warn('[publish] dedupe deferred:', String(error)); }
      if (await enrich(config, state, options.translationLimit) > 0) stateMutated = true;
      // Moderation may hide a canonical, so release its duplicates before the snapshot is built.
      const afterModeration = reconcileDuplicatePointers(state);
      if (afterModeration) { stateMutated = true; console.log(`[publish] released ${afterModeration} duplicates after moderation`); }
      // Clustering runs after translation so cross-language text can match, and
      // after moderation so it only ever merges stories that will be published.
      const unclustered = reconcileClusterPointers(state);
      if (unclustered) { stateMutated = true; console.log(`[publish] released ${unclustered} stale cluster pointers`); }
      try {
        const cluster = await runCrossSourceClusters(config, state, now);
        if (!cluster.dryRun && (cluster.checked || cluster.reset)) stateMutated = true;
        if (cluster.reset) console.log('[publish] cluster markers reset');
        else if (cluster.checked) console.log(`[publish] cluster checked ${cluster.checked}, ${cluster.dryRun ? 'would merge' : 'merged'} ${cluster.clusters}, deferred ${cluster.skipped}`);
      } catch (error) { console.warn('[publish] clustering deferred:', String(error)); }
    }
    // Overnight and off-schedule runs usually have nothing new: keep the
    // active snapshot instead of rewriting R2 and busting Worker caches.
    if (!options.repackOnly && !bootstrapped && !shouldFetch && events.length === 0 && !stateMutated &&
      base && beijingDate(now) === beijingDate(base.generatedAt) && now - base.generatedAt < 3_600_000) {
      console.log('[publish] no-op; snapshot is current');
      return;
    }
    // `feed/enrichment/` is only a cache, so a bounded sweep before publishing
    // is safe; its resume cursor rides along in the new manifest so a prefix
    // larger than one run's page budget eventually drains.
    try {
      let cleanupCursor: string | null = state.enrichmentCleanupCursor ?? null;
      for (let page = 0; page < 10; page++) {
        const result = await post<{ cursor: string | null }>(config, '/api/admin/events/cleanup', { prefix: 'feed/enrichment/', cursor: cleanupCursor });
        cleanupCursor = result.cursor;
        if (!cleanupCursor) break;
      }
      state.enrichmentCleanupCursor = cleanupCursor;
    } catch (error) { console.warn('[publish] enrichment cleanup deferred:', String(error)); }
    const items = visibleItems(state, {
      trustedXHandles: config.xTrustedHandles,
      hotGateEnabled: config.xHotGate !== false,
    });
    const built = buildSnapshot(items, {
      dataVersion: base.dataVersion + 1, lastUpdated: state.lastUpdated, lastRefreshAt: state.lastRefreshAt,
      lastIngestAttemptAt: state.lastIngestAttemptAt, sources: sourcesWithLatestItemAt(state.sources, items), enrichmentCleanupCursor: state.enrichmentCleanupCursor,
      removed: reconcileRemovedMap(base.removed ?? {}, state, now), processedEvents: events.map((event) => event.key),
    }, Date.now(), undefined, [...state.records.values()]);
    await renewal;
    if (lostLease) throw new Error('Lease lost; refusing to publish');
    await post(config, '/api/admin/publisher', { action: 'renew', token });
    console.log(`[publish] built ${items.filter((item) => !item.clusterOf).length} cards (${items.length} resolvable) / ${state.records.size} retained, ${built.artifacts.length} packs`);
    await uploadSnapshot(config, built, token, base.snapshotId);
    console.log(`[publish] activated ${built.manifest.snapshotId}; source lastUpdated=${new Date(state.lastUpdated).toISOString()}`);
    if (!options.repackOnly) {
      // A daily-archive failure must never skip acknowledging the events that
      // this snapshot already covers, nor the retention sweep below.
      try {
        const archived = await publishDailyDigests(config, items, token, built.manifest.snapshotId);
        console.log(`[publish] updated ${archived} daily archives`);
      } catch (error) { console.error('[publish] daily archives deferred:', String(error)); }
    }
    for (let offset = 0; offset < events.length; offset += 100) {
      await post(config, '/api/admin/events/ack', { keys: events.slice(offset, offset + 100).map((event) => event.key), snapshotId: built.manifest.snapshotId, token });
    }
    try {
      let cursor: string | null = null;
      for (let page = 0; page < 10; page++) {
        const result: { cursor: string | null } = await post(config, '/api/admin/events/cleanup', { prefix: 'feed/events/', cursor });
        cursor = result.cursor;
        if (!cursor) break;
      }
    } catch (error) { console.warn('[publish] retention cleanup deferred:', String(error)); }
  } finally {
    clearInterval(timer);
    await renewal;
    try { await post(config, '/api/admin/publisher', { action: 'release', token }); } catch { /* Expired leases are already fenced. */ }
  }
}
