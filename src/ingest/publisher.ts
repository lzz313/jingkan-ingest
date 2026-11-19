import { randomUUID } from 'node:crypto';
import type { FeedItem, TranslateField } from '../shared/types';
import { itemNeedsTranslation } from '../shared/translation';
import type { IngestConfig } from './env';
import { call, post, readBase, readBaseItems, readBaseRecords, uploadSnapshot } from './snapshot-client';
import { buildSnapshot } from './snapshot';
import { fetchSources } from './sources';
import { publishDailyDigests } from './daily';
import { applyEvent, bootstrapRecords, enrichmentRecords, isSourceWindow, mergeItems, deduplicateStateImages, pruneState, reconcileClusterPointers, reconcileDuplicatePointers, reconcileRemovedMap, reconcileState, updateSources, visibleItems, STATE_RETENTION_MS,
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
async function enrich(config: IngestConfig, state: GeneratorState, translationLimit = 60): Promise<void> {
  const records = enrichmentRecords(state).sort((a, b) => b.item.publishedAt - a.item.publishedAt);
  const pending = selectBacklog(records.filter((record) => record.moderation === 'pending').map((r) => r.item), 60);
  for (let offset = 0; offset < pending.length; offset += 20) {
    try {
      const result = await post<{ moderation: Array<{ id: string; contentHash: string | null; hide: boolean; reason: string | null }> }>(config, '/api/admin/enrich', { kind: 'moderate', items: pending.slice(offset, offset + 20) });
      for (const decision of result.moderation) {
        const record = state.records.get(decision.id);
        if (record?.item.contentHash !== decision.contentHash || typeof decision.hide !== 'boolean') continue;
        record.moderation = decision.hide ? 'hide' : 'keep'; record.aiReason = decision.reason ?? undefined;
      }
      console.log(`[publish] moderated ${result.moderation.length} candidates`);
    } catch (error) { console.warn('[publish] moderation pending:', String(error)); break; }
  }
  if (!config.prewarmTranslations) return;
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
        console.log(`[publish] ${task.field}: ${result.entries.length} translations`);
        if (!result.entries.length) break;
      } catch (error) { console.warn(`[publish] ${task.field} pending:`, String(error)); break; }
    }
  }
}
export async function runPublisher(config: IngestConfig, options: PublishOptions = {}): Promise<void> {
  const owner = `${process.env.GITHUB_RUN_ID ?? 'local'}:${process.env.GITHUB_RUN_ATTEMPT ?? '1'}:${randomUUID()}`;
  const claimed = await post<LeaseState>(config, '/api/admin/publisher', { action: 'claim', owner });
  const token = claimed.lease.token;
  let lostLease = false;
  let renewal: Promise<void> = Promise.resolve();
  const timer = setInterval(() => {
    renewal = renewal.then(async () => {
      try { await post(config, '/api/admin/publisher', { action: 'renew', token }); }
      catch (error) { lostLease = true; console.error('[publish] lease renewal failed', String(error)); }
    });
  }, 60000);
  try {
    const base = await readBase(config);
    const records = base.generatorStateParts
      ? await readBaseRecords<StoredItem>(config, base, base.generatorStateParts)
      : bootstrapRecords(await readBaseItems(config, base));
    const state: GeneratorState = { records: new Map(records.map((r) => [r.item.id, r])), sources: base.sources,
      lastUpdated: base.lastUpdated, lastRefreshAt: Math.max(base.lastRefreshAt, claimed.lastRefreshAt), lastIngestAttemptAt: base.lastIngestAttemptAt ?? 0 };
    console.log(`[publish] loaded ${records.length} records from ${base.generatorStateParts ? 'private state' : 'public R2 bootstrap'}`);
    const events = options.repackOnly ? [] : await pendingEvents(config);
    for (const { event } of events) applyEvent(state, event);
    const now = Date.now();
    const shouldFetch = !options.repackOnly && (options.forceFetch || claimed.lastRefreshAt > state.lastIngestAttemptAt || (isSourceWindow(now) && now - state.lastIngestAttemptAt >= 600000));
    if (shouldFetch) {
      state.lastIngestAttemptAt = now;
      const fetched = await fetchSources(now);
      mergeItems(state, fetched.items, now); updateSources(state, fetched.sourceStatus, now);
    }
    const imageRepairs = deduplicateStateImages(state);
    if (imageRepairs) console.log(`[publish] deduplicated images in ${imageRepairs} records`);
    if (!options.repackOnly) {
      pruneState(state, now - STATE_RETENTION_MS);
      console.log('[publish] policy reconciliation:', JSON.stringify(reconcileState(state)));
      const released = reconcileDuplicatePointers(state);
      if (released) console.log(`[publish] released ${released} stale duplicate pointers`);
      try {
        const dedupe = await runNodeSeekDedupe(config, state, now);
        if (dedupe.reset) console.log('[publish] duplicate markers reset');
        else if (dedupe.checked) console.log(`[publish] dedupe checked ${dedupe.checked}, ${dedupe.dryRun ? 'would hide' : 'hid'} ${dedupe.duplicates}, deferred ${dedupe.skipped}`);
      } catch (error) { console.warn('[publish] dedupe deferred:', String(error)); }
      await enrich(config, state, options.translationLimit);
      // Moderation may hide a canonical, so release its duplicates before the snapshot is built.
      const afterModeration = reconcileDuplicatePointers(state);
      if (afterModeration) console.log(`[publish] released ${afterModeration} duplicates after moderation`);
      // Clustering runs after translation so cross-language text can match, and
      // after moderation so it only ever merges stories that will be published.
      const unclustered = reconcileClusterPointers(state);
      if (unclustered) console.log(`[publish] released ${unclustered} stale cluster pointers`);
      try {
        const cluster = await runCrossSourceClusters(config, state, now);
        if (cluster.reset) console.log('[publish] cluster markers reset');
        else if (cluster.checked) console.log(`[publish] cluster checked ${cluster.checked}, ${cluster.dryRun ? 'would merge' : 'merged'} ${cluster.clusters}, deferred ${cluster.skipped}`);
      } catch (error) { console.warn('[publish] clustering deferred:', String(error)); }
    }
    const items = visibleItems(state, {
      trustedXHandles: config.xTrustedHandles,
      hotGateEnabled: config.xHotGate !== false,
    });
    const built = buildSnapshot(items, {
      dataVersion: base.dataVersion + 1, lastUpdated: state.lastUpdated, lastRefreshAt: state.lastRefreshAt,
      lastIngestAttemptAt: state.lastIngestAttemptAt, sources: state.sources,
      removed: reconcileRemovedMap(base.removed ?? {}, state, now), processedEvents: events.map((event) => event.key),
    }, Date.now(), undefined, [...state.records.values()]);
    await renewal;
    if (lostLease) throw new Error('Lease lost; refusing to publish');
    await post(config, '/api/admin/publisher', { action: 'renew', token });
    console.log(`[publish] built ${items.filter((item) => !item.clusterOf).length} cards (${items.length} resolvable) / ${state.records.size} retained, ${built.artifacts.length} packs`);
    await uploadSnapshot(config, built, token, base.snapshotId);
    console.log(`[publish] activated ${built.manifest.snapshotId}; source lastUpdated=${new Date(state.lastUpdated).toISOString()}`);
    if (!options.repackOnly) {
      const archived = await publishDailyDigests(config, items, token, built.manifest.snapshotId);
      console.log(`[publish] updated ${archived} daily archives`);
    }
    for (let offset = 0; offset < events.length; offset += 100) {
      await post(config, '/api/admin/events/ack', { keys: events.slice(offset, offset + 100).map((event) => event.key), snapshotId: built.manifest.snapshotId, token });
    }
    try {
      for (const prefix of ['feed/events/', 'feed/enrichment/']) {
        let cursor: string | null = null;
        for (let page = 0; page < 10; page++) {
          const result: { cursor: string | null } = await post(config, '/api/admin/events/cleanup', { prefix, cursor });
          cursor = result.cursor;
          if (!cursor) break;
        }
      }
    } catch (error) { console.warn('[publish] retention cleanup deferred:', String(error)); }
  } finally {
    clearInterval(timer);
    await renewal;
    try { await post(config, '/api/admin/publisher', { action: 'release', token }); } catch { /* Expired leases are already fenced. */ }
  }
}
