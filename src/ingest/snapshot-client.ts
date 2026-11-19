import { createHash } from 'node:crypto';
import type { FeedItem } from '../shared/types';
import type { IngestConfig } from './env';
import type { SnapshotManifest, SnapshotRange, SnapshotBuild } from './snapshot';
import { mapLimit } from './async';

export type BaseManifest = Omit<SnapshotManifest, 'artifacts' | 'canonicalParts'> & {
  artifacts?: SnapshotManifest['artifacts']; canonicalParts?: SnapshotRange[];
};

const REQUEST_CONCURRENCY = 4;
const CALL_RETRIES = 2;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Only 429 and 5xx are transient; a 4xx means the request itself is wrong. */
function retryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Call an admin endpoint with bounded retries. Transient 5xx and network
 * failures (a dropped upload, a Worker hiccup) are retried with backoff and
 * jitter; 4xx responses are returned to the caller immediately.
 */
export async function call(config: IngestConfig, path: string, init: RequestInit = {}, timeoutMs = 120_000, retries = CALL_RETRIES): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(250 * attempt + Math.floor(Math.random() * 100));
    let response: Response;
    try {
      response = await fetch(new URL(path, config.baseUrl), {
        ...init, headers: { authorization: `Bearer ${config.ingestToken}`, ...init.headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      lastError = error;
      continue;
    }
    if (response.ok) return response;
    const detail = (await response.text().catch(() => '')).slice(0, 500);
    const error = new Error(`Publisher request failed: HTTP ${response.status}: ${detail}`);
    if (!retryableStatus(response.status)) throw error;
    lastError = error;
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
export async function post<T>(config: IngestConfig, path: string, body: unknown, timeoutMs = 120_000): Promise<T> {
  return await (await call(config, path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }, timeoutMs)).json() as T;
}
export async function readBase(config: IngestConfig): Promise<BaseManifest> {
  return await (await call(config, '/api/admin/snapshot/base')).json() as BaseManifest;
}
export async function readBaseRecords<T>(config: IngestConfig, base: BaseManifest, ranges: SnapshotRange[]): Promise<T[]> {
  const artifacts = base.artifacts ?? [{ key: base.packKey, size: base.packSize, sha256: base.packSha256 }];
  const parts = artifacts
    .map((artifact, part) => ({ artifact, part }))
    .filter(({ artifact }) => ranges.some((range) => (range.key ?? base.packKey) === artifact.key));
  const blocks = await mapLimit(parts, REQUEST_CONCURRENCY, async ({ artifact, part }): Promise<T[]> => {
    const url = `/api/admin/snapshot/${encodeURIComponent(base.snapshotId)}/artifact` + (base.formatVersion === 2 ? `?part=${part}` : '');
    const bytes = Buffer.from(await (await call(config, url)).arrayBuffer());
    if (bytes.length !== artifact.size || createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) throw new Error('R2 base artifact integrity check failed');
    const records: T[] = [];
    for (const range of ranges) {
      if ((range.key ?? base.packKey) !== artifact.key) continue;
      if (range.offset < 0 || range.length < 1 || range.offset + range.length > bytes.length) throw new Error('Invalid R2 base range');
      const value = JSON.parse(bytes.subarray(range.offset, range.offset + range.length).toString('utf8')) as T[] | { items: T[] };
      const block = Array.isArray(value) ? value : value.items;
      if (!Array.isArray(block)) throw new Error('Invalid R2 base records');
      records.push(...block);
    }
    return records;
  });
  if (ranges.some((range) => !artifacts.some((artifact) => artifact.key === (range.key ?? base.packKey)))) throw new Error('Missing R2 base artifact');
  return blocks.flat();
}
export async function readBaseItems(config: IngestConfig, base: BaseManifest): Promise<FeedItem[]> {
  return readBaseRecords(config, base, base.canonicalParts ?? [base.canonical]);
}
export async function uploadSnapshot(config: IngestConfig, built: SnapshotBuild, token: string, expectedSnapshotId: string): Promise<void> {
  const { artifacts, manifest } = built;
  await mapLimit(artifacts.map((artifact, part) => ({ artifact, part })), REQUEST_CONCURRENCY, async ({ artifact, part }) => {
    await call(config, `/api/admin/snapshot/${encodeURIComponent(manifest.snapshotId)}/artifact?part=${part}`, {
      method: 'PUT', body: new Uint8Array(artifact.body), headers: {
        'content-length': String(artifact.body.length), 'content-type': 'application/octet-stream', 'x-content-sha256': artifact.sha256,
      },
    });
  });
  await call(config, `/api/admin/snapshot/${encodeURIComponent(manifest.snapshotId)}/manifest`, {
    method: 'PUT', body: JSON.stringify(manifest), headers: { 'content-type': 'application/json' },
  });
  await call(config, `/api/admin/snapshot/${encodeURIComponent(manifest.snapshotId)}/activate`, {
    method: 'POST', headers: { 'x-publisher-lease': token, 'x-expected-snapshot': expectedSnapshotId },
  });
}
