import { createHash } from 'node:crypto';
import type { FeedItem, SourceStatus, SourceId } from '../shared/types';
import type { IngestConfig } from './env';
import { buildSnapshot, type SnapshotManifest, type SnapshotMeta } from './snapshot';

type BaseManifest = Omit<SnapshotManifest, 'artifacts' | 'canonicalParts'> & {
  artifacts?: SnapshotManifest['artifacts']; canonicalParts?: SnapshotManifest['canonicalParts'];
};
interface SyncMeta {
  meta: { dataVersion: number; lastUpdated: number; lastRefreshAt: number };
  sources: Partial<Record<SourceId, SourceStatus>>;
  retentionDays: number;
  rowsReadToday: number;
}
interface SyncPage {
  items: FeedItem[];
  removed: Array<{ id: string; publishedAt: number }>;
  nextCursor: string | null;
  rowsRead: number;
}
export class SnapshotDeferred extends Error {
  constructor(public readonly retryAt: number) { super(`Snapshot export paused until ${new Date(retryAt).toISOString()}`); }
}
async function call(config: IngestConfig, path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(new URL(path, config.baseUrl), {
    ...init,
    headers: { authorization: `Bearer ${config.ingestToken}`, ...init.headers },
    signal: AbortSignal.timeout(120_000),
  });
  if (response.status === 429) {
    const payload = await response.json() as { retryAt?: number };
    throw new SnapshotDeferred(payload.retryAt ?? Date.now() + 300_000);
  }
  if (!response.ok) throw new Error(`Snapshot request failed: HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
  return response;
}
async function getMeta(config: IngestConfig): Promise<SyncMeta> {
  return await (await call(config, '/api/admin/snapshot/sync-meta')).json() as SyncMeta;
}

export async function readBaseItems(config: IngestConfig, base: BaseManifest): Promise<FeedItem[]> {
  const artifacts = base.artifacts ?? [{ key: base.packKey, size: base.packSize, sha256: base.packSha256 }];
  const ranges = base.canonicalParts ?? [base.canonical];
  const items: FeedItem[] = [];
  // Only download parts containing canonical blocks; pre-built feed pages need
  // not cross the network just to compute a delta or a new ranking snapshot.
  for (const [part, artifact] of artifacts.entries()) {
    const selected = ranges.filter((range) => (range.key ?? base.packKey) === artifact.key);
    if (selected.length === 0) continue;
    const url = `/api/admin/snapshot/${encodeURIComponent(base.snapshotId)}/artifact` + (base.formatVersion === 2 ? `?part=${part}` : '');
    const bytes = Buffer.from(await (await call(config, url)).arrayBuffer());
    if (bytes.length !== artifact.size || createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) {
      throw new Error('R2 base artifact integrity check failed');
    }
    for (const range of selected) {
      const value = JSON.parse(bytes.subarray(range.offset, range.offset + range.length).toString('utf8')) as FeedItem[] | { items: FeedItem[] };
      const block = Array.isArray(value) ? value : value.items;
      if (!Array.isArray(block)) throw new Error('Invalid R2 base items');
      items.push(...block);
    }
  }
  return items;
}
function sameMeta(left: SyncMeta, right: SyncMeta): boolean {
  return left.meta.dataVersion === right.meta.dataVersion && left.meta.lastUpdated === right.meta.lastUpdated &&
    left.meta.lastRefreshAt === right.meta.lastRefreshAt;
}

export async function collectSnapshot(config: IngestConfig): Promise<{ items: FeedItem[]; meta: SnapshotMeta }> {
  let base: BaseManifest | null = null;
  let baseItems: FeedItem[] = [];
  let loadedBase = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await getMeta(config);
    if (!loadedBase) {
      const response = await fetch(new URL('/api/admin/snapshot/base', config.baseUrl), {
        headers: { authorization: `Bearer ${config.ingestToken}` }, signal: AbortSignal.timeout(30_000),
      });
      if (response.ok) {
        base = await response.json() as BaseManifest;
        baseItems = await readBaseItems(config, base);
      } else if (![404, 503].includes(response.status)) {
        throw new Error(`Unable to read R2 base: HTTP ${response.status}`);
      }
      loadedBase = true;
    }
    const until = before.meta.dataVersion;
    const since = base?.syncRevision !== undefined && base.syncRevision <= until ? base.syncRevision : -1;
    const items = new Map((since >= 0 ? baseItems : []).map((item) => [item.id, item]));
    const removed = { ...(since >= 0 ? base?.removed : {}) };
    const from = Date.now() - before.retentionDays * 86_400_000;
    let rowsRead = 0;
    if (since !== until) {
      let cursor: string | null = null;
      do {
        const query = new URLSearchParams({ since: String(since), until: String(until), from: String(Math.floor(from)), limit: '200' });
        if (cursor) query.set('cursor', cursor);
        const page = await (await call(config, '/api/admin/snapshot/sync?' + query)).json() as SyncPage;
        for (const item of page.items) { items.set(item.id, item); delete removed[item.id]; }
        for (const entry of page.removed) { items.delete(entry.id); removed[entry.id] = entry.publishedAt; }
        rowsRead += page.rowsRead;
        cursor = page.nextCursor;
      } while (cursor);
    }
    const after = await getMeta(config);
    if (!sameMeta(before, after)) continue;
    for (const [id, timestamp] of Object.entries(removed)) if (timestamp < from) delete removed[id];
    console.log(`[snapshot] sync ${since}->${until}: rowsRead=${rowsRead}, day=${after.rowsReadToday}, attempt=${attempt + 1}`);
    return {
      items: [...items.values()].filter((item) => item.publishedAt >= from),
      meta: { ...after.meta, sources: after.sources, syncRevision: until, removed },
    };
  }
  throw new Error('Snapshot source changed during export; keeping the active snapshot');
}

export async function runSnapshot(config: IngestConfig, options: { repackOnly?: boolean } = {}): Promise<void> {
  let state: { items: FeedItem[]; meta: SnapshotMeta };
  if (options.repackOnly) {
    const base = await (await call(config, '/api/admin/snapshot/base')).json() as BaseManifest;
    state = {
      items: await readBaseItems(config, base),
      meta: {
        lastUpdated: base.lastUpdated, dataVersion: base.dataVersion, lastRefreshAt: base.lastRefreshAt,
        sources: base.sources, syncRevision: base.syncRevision, removed: base.removed,
      },
    };
    console.log(`[snapshot] repacking ${base.snapshotId}; source timestamps preserved`);
  } else {
    state = await collectSnapshot(config);
  }
  const { items, meta } = state;
  const { artifacts, manifest } = buildSnapshot(items, meta);
  console.log(`[snapshot] built ${manifest.snapshotId}: ${items.length} items, ${manifest.packSize} bytes, ${artifacts.length} parts`);
  for (const [part, artifact] of artifacts.entries()) {
    await (await call(config, `/api/admin/snapshot/${encodeURIComponent(manifest.snapshotId)}/artifact?part=${part}`, {
      method: 'PUT', body: new Uint8Array(artifact.body), headers: {
        'content-length': String(artifact.body.length), 'content-type': 'application/octet-stream', 'x-content-sha256': artifact.sha256,
      },
    })).arrayBuffer();
  }
  await (await call(config, `/api/admin/snapshot/${encodeURIComponent(manifest.snapshotId)}/manifest`, {
    method: 'PUT', body: JSON.stringify(manifest), headers: { 'content-type': 'application/json' },
  })).arrayBuffer();
  await call(config, `/api/admin/snapshot/${encodeURIComponent(manifest.snapshotId)}/activate`, { method: 'POST' });
  console.log(`[snapshot] activated ${manifest.snapshotId}`);
}
