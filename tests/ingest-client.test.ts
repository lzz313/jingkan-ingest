import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IngestRequest, NormalizedItem } from '../src/shared/types';
import { postIngest } from '../src/ingest/ingest-client';

function item(index: number): NormalizedItem {
  return {
    source: 'x',
    externalId: String(index),
    title: `Item ${index}`,
    url: `https://x.com/i/web/status/${index}`,
    publishedAt: 1_800_000_000_000 + index,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('postIngest', () => {
  it('marks intermediate chunks partial and only finalizes metadata last', async () => {
    const bodies: IngestRequest[] = [];
    vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as IngestRequest);
      const request = JSON.parse(String(init?.body)) as IngestRequest;
      return new Response(
        JSON.stringify({
          upserted: request.items.length,
          ids: request.items.map((entry) => `x:${entry.externalId}`),
          dataVersion: bodies.length,
          lastUpdated: 123,
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    });

    await postIngest(
      {
        baseUrl: 'https://jing.show',
        ingestToken: 'secret',
        prewarmTranslations: false,
      },
      Array.from({ length: 41 }, (_, index) => item(index)),
      { sourceStatus: { x: { ok: true, count: 41 } } },
    );

    expect(bodies.map((body) => body.partial)).toEqual([true, true, false]);
    expect(bodies.slice(0, 2).every((body) => !body.sourceStatus)).toBe(true);
    expect(bodies[2]?.sourceStatus).toEqual({ x: { ok: true, count: 41 } });
  });
});
