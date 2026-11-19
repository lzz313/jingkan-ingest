import type { IngestConfig } from './env';
import { post } from './snapshot-client';
import { mapLimit } from './async';

/** The Worker accepts at most 20 texts per request. */
export const EMBED_BATCH_SIZE = 20;
/** ...and at most 12,000 characters across the whole batch. */
export const MAX_EMBED_TOTAL_CHARS = 12_000;
const BATCH_CONCURRENCY = 2;

interface EmbedResponse {
  model?: unknown;
  dimensions?: unknown;
  embeddings?: unknown;
}

export interface EmbedResult {
  model: string;
  vectors: number[][];
}

interface TextEntry {
  text: string;
  index: number;
}

/**
 * Pack as many texts per request as both Worker limits allow. A single text
 * longer than the total budget gets a batch of its own and is truncated.
 */
function packBatches(entries: TextEntry[]): TextEntry[][] {
  const batches: TextEntry[][] = [];
  let batch: TextEntry[] = [];
  let characters = 0;
  for (const entry of entries) {
    if (batch.length > 0 && (batch.length >= EMBED_BATCH_SIZE || characters + entry.text.length > MAX_EMBED_TOTAL_CHARS)) {
      batches.push(batch);
      batch = [];
      characters = 0;
    }
    batch.push(entry);
    characters += entry.text.length;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

/**
 * Batch embeddings through the admin endpoint. Vectors are validated locally
 * because a silently short batch would misalign ids and verdicts.
 *
 * Texts that are blank after trimming are not sent (the Worker rejects them);
 * their slots stay empty so callers see no vector and leave the record
 * unmarked. If a later request fails, earlier vectors are returned so those
 * records can still be judged; the rest retry on the next run.
 */
export function createEmbedder(config: IngestConfig, timeoutMs: number): (texts: string[]) => Promise<EmbedResult> {
  return async (texts: string[]): Promise<EmbedResult> => {
    const prepared = texts.map((text) => text.trim().slice(0, MAX_EMBED_TOTAL_CHARS));
    // Holes are intentional: `undefined` tells the caller this id was not embedded.
    const vectors = new Array<number[]>(prepared.length);
    const pending = prepared
      .map((text, index): TextEntry => ({ text, index }))
      .filter((entry) => entry.text.length > 0);
    const batches = packBatches(pending);
    const results = await mapLimit(batches, BATCH_CONCURRENCY, async (batch) => {
      try {
        return { batch, response: await post<EmbedResponse>(config, '/api/admin/embed', { texts: batch.map((entry) => entry.text) }, timeoutMs) };
      } catch (error) {
        return { batch, error };
      }
    });

    let model = '';
    let dimensions = 0;
    let firstError: unknown = null;
    for (const result of results) {
      if ('error' in result) {
        if (firstError === null) firstError = result.error;
        continue;
      }
      const { batch, response } = result;
      const embeddings = response?.embeddings;
      const found = response?.dimensions;
      if (!Array.isArray(embeddings) || embeddings.length !== batch.length) throw new Error('Embedding batch length mismatch');
      if (typeof found !== 'number' || !Number.isInteger(found) || found < 8 || found > 4096) throw new Error('Invalid embedding dimensions');
      if (!dimensions) dimensions = found;
      if (found !== dimensions) throw new Error('Embedding dimensions changed between batches');
      if (typeof response?.model === 'string' && response.model) model = response.model;
      for (const [offset, vector] of embeddings.entries()) {
        if (!Array.isArray(vector) || vector.length !== dimensions ||
          vector.some((value) => typeof value !== 'number' || !Number.isFinite(value))) throw new Error('Invalid embedding vector');
        vectors[batch[offset]!.index] = vector as number[];
      }
    }
    if (firstError !== null) {
      // Before any batch succeeds there is nothing partial to return, so fail
      // open the way callers expect (retry all records next run).
      if (!dimensions) throw firstError;
      console.warn('[embed] later batch failed; keeping succeeded vectors:', String(firstError));
    }
    return { model, vectors: vectors as number[][] };
  };
}
