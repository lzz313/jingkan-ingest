import type { FeedItem, SourceId, SourceStatus } from '../shared/types';
import { SOURCE_IDS } from '../shared/types';
import { loadConfig, type IngestConfig } from './env';
import { buildSnapshot, type SnapshotMeta } from './snapshot';

interface ExportPage {
  items: FeedItem[];
  nextCursor: string | null;
  meta: Omit<SnapshotMeta, 'sources'>;
  sources: Partial<Record<SourceId, SourceStatus>>;
}

interface SnapshotStatus {
  ok: boolean;
  snapshotId?: string;
  dataVersion?: number;
}

function authHeaders(config: IngestConfig): Record<string, string> {
  return { authorization: `Bearer ${config.ingestToken}` };
}

async function readError(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  return `HTTP ${response.status}${text ? `: ${text.slice(0, 500)}` : ''}`;
}

async function exportPage(
  config: IngestConfig,
  source: SourceId,
  cursor?: string,
): Promise<ExportPage> {
  const url = new URL('/api/admin/snapshot/export', config.baseUrl);
  url.searchParams.set('source', source);
  url.searchParams.set('limit', '200');
  if (cursor) url.searchParams.set('cursor', cursor);
  const response = await fetch(url, {
    headers: authHeaders(config),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`Snapshot export failed: ${await readError(response)}`);
  return (await response.json()) as ExportPage;
}

async function collectSource(
  config: IngestConfig,
  source: SourceId,
): Promise<{ items: FeedItem[]; meta: ExportPage['meta']; sources: ExportPage['sources'] }> {
  const items: FeedItem[] = [];
  let cursor: string | undefined;
  let meta: ExportPage['meta'] | null = null;
  let sources: ExportPage['sources'] = {};
  do {
    const page = await exportPage(config, source, cursor);
    items.push(...page.items);
    meta ??= page.meta;
    sources = page.sources;
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  if (!meta) throw new Error(`Snapshot export returned no metadata for ${source}`);
  return { items, meta, sources };
}

function sameMeta(left: ExportPage['meta'], right: ExportPage['meta']): boolean {
  return (
    left.dataVersion === right.dataVersion &&
    left.lastUpdated === right.lastUpdated &&
    left.lastRefreshAt === right.lastRefreshAt
  );
}

async function collectStableSnapshot(
  config: IngestConfig,
): Promise<{ items: FeedItem[]; meta: SnapshotMeta }> {
  let lastReason = 'data changed during export';
  for (let attempt = 1; attempt <= 3; attempt++) {
    const results = await Promise.all(
      SOURCE_IDS.map((source) => collectSource(config, source)),
    );
    const first = results[0];
    if (!first) throw new Error('No snapshot sources are configured');
    if (!results.every((result) => sameMeta(first.meta, result.meta))) {
      lastReason = 'sources returned different data versions';
      continue;
    }

    // A final fresh page catches writes that completed after one source was
    // exported but before another started.
    const after = await exportPage(config, 'x');
    if (!sameMeta(first.meta, after.meta)) {
      lastReason = 'data changed while the snapshot was being assembled';
      continue;
    }

    const byId = new Map<string, FeedItem>();
    for (const result of results) {
      for (const item of result.items) byId.set(item.id, item);
    }
    return {
      items: [...byId.values()],
      meta: { ...first.meta, sources: after.sources ?? first.sources },
    };
  }
  throw new Error(`Snapshot export was unstable after 3 attempts: ${lastReason}`);
}

async function put(config: IngestConfig, path: string, init: RequestInit): Promise<Response> {
  const response = await fetch(new URL(path, config.baseUrl), {
    ...init,
    method: 'PUT',
    headers: { ...authHeaders(config), ...(init.headers as Record<string, string>) },
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`Snapshot upload failed: ${await readError(response)}`);
  return response;
}

async function activate(config: IngestConfig, snapshotId: string): Promise<void> {
  const response = await fetch(
    new URL(`/api/admin/snapshot/${encodeURIComponent(snapshotId)}/activate`, config.baseUrl),
    {
      method: 'POST',
      headers: authHeaders(config),
      signal: AbortSignal.timeout(60_000),
    },
  );
  if (!response.ok) throw new Error(`Snapshot activation failed: ${await readError(response)}`);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const statusResponse = await fetch(new URL('/api/admin/snapshot/status', config.baseUrl), {
    headers: authHeaders(config),
    signal: AbortSignal.timeout(30_000),
  });
  if (statusResponse.ok) {
    const status = (await statusResponse.json()) as SnapshotStatus;
    if (status.snapshotId) console.log(`[snapshot] current=${status.snapshotId}`);
  }

  const { items, meta } = await collectStableSnapshot(config);
  const { artifacts, manifest } = buildSnapshot(items, meta);
  console.log(
    `[snapshot] built ${manifest.snapshotId}: ${items.length} items, ` +
      `${Object.keys(manifest.responses).length} responses, ` +
      `${manifest.packSize} bytes in ${artifacts.length} parts`,
  );

  for (const [part, artifact] of artifacts.entries()) {
    const response = await put(
      config,
      `/api/admin/snapshot/${encodeURIComponent(manifest.snapshotId)}/artifact?part=${part}`,
      {
        body: new Uint8Array(artifact.body),
        headers: {
          'content-length': String(artifact.body.length),
          'content-type': 'application/octet-stream',
          'x-content-sha256': artifact.sha256,
        },
      },
    );
    await response.arrayBuffer();
  }

  const manifestResponse = await put(
    config,
    `/api/admin/snapshot/${encodeURIComponent(manifest.snapshotId)}/manifest`,
    {
      body: JSON.stringify(manifest),
      headers: { 'content-type': 'application/json' },
    },
  );
  await manifestResponse.arrayBuffer();
  await activate(config, manifest.snapshotId);
  console.log(`[snapshot] activated ${manifest.snapshotId}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
