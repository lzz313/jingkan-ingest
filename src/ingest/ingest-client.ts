import type {
  AdminRecentItem,
  IngestRequest,
  IngestResponse,
  IngestStatus,
  MaintenancePatch,
  NormalizedItem,
  SourceId,
  TranslateResponse,
} from '../shared/types';
import type { IngestConfig } from './env';

const CHUNK_SIZE = 20;

function authHeaders(config: IngestConfig): Record<string, string> {
  return {
    authorization: `Bearer ${config.ingestToken}`,
    'content-type': 'application/json',
  };
}

async function readError(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  return `HTTP ${response.status}${text ? `: ${text.slice(0, 500)}` : ''}`;
}

export async function postIngest(
  config: IngestConfig,
  items: NormalizedItem[],
  options: {
    partial?: boolean;
    sourceStatus?: Partial<Record<SourceId, IngestStatus>>;
  } = {},
): Promise<IngestResponse> {
  const allIds: string[] = [];
  let upserted = 0;
  let dataVersion = 0;
  let lastUpdated = 0;

  const chunks: NormalizedItem[][] =
    items.length === 0 ? [[]] : Array.from({ length: Math.ceil(items.length / CHUNK_SIZE) }, (_, i) =>
      items.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE),
    );

  for (const [index, chunk] of chunks.entries()) {
    const body: IngestRequest = {
      items: chunk,
      partial: options.partial ?? false,
      ...(options.sourceStatus && index === chunks.length - 1
        ? { sourceStatus: options.sourceStatus }
        : {}),
    };

    const response = await fetch(`${config.baseUrl}/api/ingest`, {
      method: 'POST',
      headers: authHeaders(config),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`Ingest failed: ${await readError(response)}`);

    const result = (await response.json()) as IngestResponse;
    allIds.push(...result.ids);
    upserted += result.upserted;
    dataVersion = result.dataVersion;
    lastUpdated = result.lastUpdated;
  }

  return { upserted, ids: allIds, dataVersion, lastUpdated };
}

export async function prewarmTranslations(
  config: IngestConfig,
  ids: string[],
  field: 'title' | 'body',
): Promise<TranslateResponse> {
  const translations: Record<string, string> = {};
  for (let i = 0; i < ids.length; i += 10) {
    const chunk = ids.slice(i, i + 10);
    const response = await fetch(`${config.baseUrl}/api/translate`, {
      method: 'POST',
      headers: authHeaders(config),
      body: JSON.stringify({ ids: chunk, field }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!response.ok) throw new Error(`Translate prewarm failed: ${await readError(response)}`);
    const result = (await response.json()) as TranslateResponse;
    Object.assign(translations, result.translations);
  }
  return { translations };
}

export async function fetchAdminRecent(
  config: IngestConfig,
  limit = 200,
): Promise<AdminRecentItem[]> {
  const response = await fetch(`${config.baseUrl}/api/admin/recent?limit=${limit}`, {
    headers: authHeaders(config),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Admin recent failed: ${await readError(response)}`);
  const result = (await response.json()) as { items: AdminRecentItem[] };
  return result.items;
}

export async function postMaintenance(
  config: IngestConfig,
  patches: MaintenancePatch[],
): Promise<number> {
  if (patches.length === 0) return 0;
  const response = await fetch(`${config.baseUrl}/api/admin/maintenance`, {
    method: 'POST',
    headers: authHeaders(config),
    body: JSON.stringify({ patches }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Maintenance failed: ${await readError(response)}`);
  const result = (await response.json()) as { updated: number };
  return result.updated;
}
