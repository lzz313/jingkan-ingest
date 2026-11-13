import { createHash } from 'node:crypto';
import type { FeedItem } from '../shared/types';
import type { IngestConfig } from './env';
import type { SnapshotManifest, SnapshotRange, SnapshotBuild } from './snapshot';

export type BaseManifest = Omit<SnapshotManifest, 'artifacts' | 'canonicalParts'> & {
  artifacts?: SnapshotManifest['artifacts']; canonicalParts?: SnapshotRange[];
};
export async function call(config: IngestConfig, path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(new URL(path, config.baseUrl), {
    ...init, headers: { authorization: `Bearer ${config.ingestToken}`, ...init.headers },
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`Publisher request failed: HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
  return response;
}
export async function post<T>(config: IngestConfig, path: string, body: unknown): Promise<T> {
  return await (await call(config, path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })).json() as T;
}
export async function readBase(config: IngestConfig): Promise<BaseManifest> {
  return await (await call(config, '/api/admin/snapshot/base')).json() as BaseManifest;
}
export async function readBaseRecords<T>(config: IngestConfig, base: BaseManifest, ranges: SnapshotRange[]): Promise<T[]> {
  const artifacts = base.artifacts ?? [{ key: base.packKey, size: base.packSize, sha256: base.packSha256 }];
  const records: T[] = [];
  for (const [part, artifact] of artifacts.entries()) {
    const selected = ranges.filter((range) => (range.key ?? base.packKey) === artifact.key);
    if (!selected.length) continue;
    const url = `/api/admin/snapshot/${encodeURIComponent(base.snapshotId)}/artifact` + (base.formatVersion === 2 ? `?part=${part}` : '');
    const bytes = Buffer.from(await (await call(config, url)).arrayBuffer());
    if (bytes.length !== artifact.size || createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) throw new Error('R2 base artifact integrity check failed');
    for (const range of selected) {
      if (range.offset < 0 || range.length < 1 || range.offset + range.length > bytes.length) throw new Error('Invalid R2 base range');
      const value = JSON.parse(bytes.subarray(range.offset, range.offset + range.length).toString('utf8')) as T[] | { items: T[] };
      const block = Array.isArray(value) ? value : value.items;
      if (!Array.isArray(block)) throw new Error('Invalid R2 base records');
      records.push(...block);
    }
  }
  if (ranges.some((range) => !artifacts.some((artifact) => artifact.key === (range.key ?? base.packKey)))) throw new Error('Missing R2 base artifact');
  return records;
}
export async function readBaseItems(config: IngestConfig, base: BaseManifest): Promise<FeedItem[]> {
  return readBaseRecords(config, base, base.canonicalParts ?? [base.canonical]);
}
export async function uploadSnapshot(config: IngestConfig, built: SnapshotBuild, token: string, expectedSnapshotId: string): Promise<void> {
  const { artifacts, manifest } = built;
  for (const [part, artifact] of artifacts.entries()) {
    await call(config, `/api/admin/snapshot/${encodeURIComponent(manifest.snapshotId)}/artifact?part=${part}`, {
      method: 'PUT', body: new Uint8Array(artifact.body), headers: {
        'content-length': String(artifact.body.length), 'content-type': 'application/octet-stream', 'x-content-sha256': artifact.sha256,
      },
    });
  }
  await call(config, `/api/admin/snapshot/${encodeURIComponent(manifest.snapshotId)}/manifest`, {
    method: 'PUT', body: JSON.stringify(manifest), headers: { 'content-type': 'application/json' },
  });
  await call(config, `/api/admin/snapshot/${encodeURIComponent(manifest.snapshotId)}/activate`, {
    method: 'POST', headers: { 'x-publisher-lease': token, 'x-expected-snapshot': expectedSnapshotId },
  });
}
