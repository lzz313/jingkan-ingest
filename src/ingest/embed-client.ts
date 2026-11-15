import type { IngestConfig } from './env';
import { post } from './snapshot-client';

/** The Worker accepts at most 20 texts per request. */
export const EMBED_BATCH_SIZE = 20;

interface EmbedResponse {
  model?: unknown;
  dimensions?: unknown;
  embeddings?: unknown;
}

export interface EmbedResult {
  model: string;
  vectors: number[][];
}

/**
 * Batch embeddings through the admin endpoint. Vectors are validated locally
 * because a silently short batch would misalign ids and verdicts.
 */
export function createEmbedder(config: IngestConfig, timeoutMs: number): (texts: string[]) => Promise<EmbedResult> {
  return async (texts: string[]): Promise<EmbedResult> => {
    const vectors: number[][] = [];
    let model = '';
    let dimensions = 0;
    for (let offset = 0; offset < texts.length; offset += EMBED_BATCH_SIZE) {
      const batch = texts.slice(offset, offset + EMBED_BATCH_SIZE);
      const response = await post<EmbedResponse>(config, '/api/admin/embed', { texts: batch }, timeoutMs);
      const embeddings = response?.embeddings;
      const found = response?.dimensions;
      if (!Array.isArray(embeddings) || embeddings.length !== batch.length) throw new Error('Embedding batch length mismatch');
      if (typeof found !== 'number' || !Number.isInteger(found) || found < 8 || found > 4096) throw new Error('Invalid embedding dimensions');
      if (!dimensions) dimensions = found;
      if (found !== dimensions) throw new Error('Embedding dimensions changed between batches');
      if (typeof response?.model === 'string' && response.model) model = response.model;
      for (const vector of embeddings) {
        if (!Array.isArray(vector) || vector.length !== dimensions ||
          vector.some((value) => typeof value !== 'number' || !Number.isFinite(value))) throw new Error('Invalid embedding vector');
        vectors.push(vector as number[]);
      }
    }
    return { model, vectors };
  };
}
