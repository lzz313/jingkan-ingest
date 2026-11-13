import type {
  IngestRequest,
  IngestResponse,
  IngestStatus,
  NormalizedItem,
  SourceId,
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
      // Only the final chunk represents the completed ingest run. Marking
      // intermediate pages partial avoids rewriting `last_updated` and makes
      // the source status land in the final queued input event.
      partial: options.partial ?? index < chunks.length - 1,
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
