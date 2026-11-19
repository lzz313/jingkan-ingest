import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLUSTER_DEFAULTS, DEDUPE_DEFAULTS, type DedupeConfig, type IngestConfig } from '../src/ingest/env';
import {
  canonicalOrder,
  cosine,
  dedupeFingerprint,
  embeddingText,
  lexicalSimilarity,
  runNodeSeekDedupe,
} from '../src/ingest/dedupe';
import { createEmbedder } from '../src/ingest/embed-client';
import { enrichmentRecords, removedItems, visibleItems, type GeneratorState, type StoredItem } from '../src/ingest/state';
import type { FeedItem } from '../src/shared/types';

const NOW = Date.UTC(2026, 10, 15, 2);
const SAME = [1, 0, 0, 0, 0, 0, 0, 0];
const ORTHOGONAL = [0, 0, 0, 0, 0, 0, 0, 1];

function feedItem(id: string, overrides: Partial<FeedItem> = {}): FeedItem {
  const externalId = id.split(':')[1] ?? id;
  return {
    id,
    source: 'nodeseek',
    externalId,
    storyKey: null,
    title: id,
    titleZh: null,
    body: `正文 ${id}`,
    brief: null,
    briefZh: null,
    bodyZh: null,
    url: `https://www.nodeseek.com/post-${externalId}`,
    author: null,
    authorHandle: null,
    publishedAt: NOW - 3600000,
    firstSeenAt: NOW - 3600000,
    fetchedAt: NOW,
    metrics: {},
    hotScore: 0,
    isHot: false,
    images: [],
    extra: {},
    hidden: false,
    contentHash: `hash-${id}`,
    ...overrides,
  };
}

function stored(item: FeedItem, overrides: Partial<StoredItem> = {}): StoredItem {
  return { item, observedAt: NOW, ruleHidden: false, moderation: 'keep', ...overrides };
}

function makeState(...entries: Array<FeedItem | StoredItem>): GeneratorState {
  const records = entries.map((entry) => ('item' in entry ? entry : stored(entry)));
  return { records: new Map(records.map((record) => [record.item.id, record])), sources: {}, lastUpdated: 0, lastRefreshAt: 0, lastIngestAttemptAt: 0 };
}

function config(dedupe: Partial<DedupeConfig> = {}): IngestConfig {
  return {
    baseUrl: 'https://jing.show',
    ingestToken: 'test',
    prewarmTranslations: false,
    dedupe: { ...DEDUPE_DEFAULTS, enabled: true, ...dedupe },
    cluster: CLUSTER_DEFAULTS,
  };
}

function stubEmbedding(embedding: (text: string) => number[]) {
  const calls: string[][] = [];
  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const texts = (JSON.parse(String(init?.body)) as { texts: string[] }).texts;
    calls.push(texts);
    return new Response(JSON.stringify({ model: 'test-embed', dimensions: 8, embeddings: texts.map(embedding) }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }));
  return calls;
}

function byMarker(vectors: Record<string, number[]>): (text: string) => number[] {
  return (text) => {
    for (const [marker, vector] of Object.entries(vectors)) if (text.includes(marker)) return vector;
    return ORTHOGONAL;
  };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('NodeSeek lexical prefilter', () => {
  it('normalizes NFKC, full-width text and tracking-free URLs', () => {
    expect(lexicalSimilarity(
      feedItem('nodeseek:1', { title: 'ＶＰＳ 补货通知', body: '' }),
      feedItem('nodeseek:2', { title: 'vps 补货通知', body: '' }),
    )).toBe(1);
    expect(lexicalSimilarity(
      feedItem('nodeseek:1', { title: '甲标题', body: '入口 https://example.com/promo?utm_source=a' }),
      feedItem('nodeseek:2', { title: '乙标题', body: '入口 https://example.com/promo?ref=b' }),
    )).toBe(1);
    expect(lexicalSimilarity(
      feedItem('nodeseek:1', { title: '同一标题', body: '' }),
      feedItem('nodeseek:2', { title: '同一标题', body: '' }),
    )).toBe(1);
  });

  it('scores paraphrases, product names and unrelated posts differently', () => {
    const related = lexicalSimilarity(
      feedItem('nodeseek:1', { title: '搬瓦工 CN2 GIA 补货通知', body: '' }),
      feedItem('nodeseek:2', { title: '搬瓦工 CN2 GIA 套餐补货', body: '' }),
    );
    expect(related).toBeGreaterThan(0.18);
    const unrelated = lexicalSimilarity(
      feedItem('nodeseek:1', { title: '搬瓦工 CN2 GIA 补货通知', body: '' }),
      feedItem('nodeseek:2', { title: 'Claude 使用体验分享', body: '' }),
    );
    expect(unrelated).toBeLessThan(0.18);
    expect(lexicalSimilarity(
      feedItem('nodeseek:1', { title: 'Cloudflare WARP 使用体验', body: '' }),
      feedItem('nodeseek:2', { title: 'WARP 客户端对比', body: '' }),
    )).toBe(1);
  });

  it('damps generic short titles with no shared product token', () => {
    expect(lexicalSimilarity(
      feedItem('nodeseek:1', { title: '求推荐节点', body: '' }),
      feedItem('nodeseek:2', { title: '求稳定节点', body: '' }),
    )).toBeCloseTo(0.15, 5);
  });

  it('caps embedding text while keeping the title whole', () => {
    const text = embeddingText(feedItem('nodeseek:1', { title: '标题', body: 'b'.repeat(1000) }), 50);
    expect(text).toHaveLength(50);
    expect(text.startsWith('标题\n')).toBe(true);
  });

  it('ignores a bare homepage link as duplicate evidence', () => {
    // Two unrelated posts that both cite the same homepage must not be
    // treated as sharing an article.
    expect(lexicalSimilarity(
      feedItem('nodeseek:1', { title: '苹果发布会', body: '来源 https://example.com/' }),
      feedItem('nodeseek:2', { title: '数据库迁移', body: '来源 https://example.com/' }),
    )).toBe(0);
  });
});

describe('cosine and fingerprint', () => {
  it('computes cosine and guards empty or mismatched vectors', () => {
    expect(cosine([1, 0], [0.85, Math.sqrt(1 - 0.85 ** 2)])).toBeCloseTo(0.85, 6);
    expect(cosine([1, 0], [0, 1])).toBe(0);
    expect(cosine([], [])).toBe(0);
    expect(cosine([1], [1, 2])).toBe(0);
  });

  it('changes with verdict settings but not with budget knobs', () => {
    const base = dedupeFingerprint(DEDUPE_DEFAULTS);
    expect(dedupeFingerprint({ ...DEDUPE_DEFAULTS, cosineThreshold: 0.9 })).not.toBe(base);
    expect(dedupeFingerprint({ ...DEDUPE_DEFAULTS, lexicalThreshold: 0.24 })).not.toBe(base);
    expect(dedupeFingerprint({ ...DEDUPE_DEFAULTS, windowDays: 3 })).not.toBe(base);
    expect(dedupeFingerprint({ ...DEDUPE_DEFAULTS, textChars: 400 })).not.toBe(base);
    expect(dedupeFingerprint({ ...DEDUPE_DEFAULTS, maxChecks: 99, maxTexts: 300, timeoutMs: 5000 })).toBe(base);
  });
});

describe('runNodeSeekDedupe', () => {
  it('hides the later post, records evidence and releases enrichment budget', async () => {
    const older = feedItem('nodeseek:1', { title: '搬瓦工 CN2 GIA 补货通知', body: '搬瓦工 CN2 GIA 套餐补货了。', publishedAt: NOW - 7200000 });
    const newer = feedItem('nodeseek:2', { title: '搬瓦工 CN2 GIA 补货通知', body: '搬瓦工 CN2 GIA 套餐又补货了。', publishedAt: NOW - 3600000 });
    const state = makeState(older, newer);
    const calls = stubEmbedding(byMarker({ 搬瓦工: SAME }));

    const result = await runNodeSeekDedupe(config(), state, NOW);

    expect(result).toMatchObject({ checked: 2, duplicates: 1, skipped: 0, dryRun: false, reset: false });
    const duplicate = state.records.get('nodeseek:2')!;
    expect(duplicate.duplicateOf).toBe('nodeseek:1');
    expect(duplicate.dedupe).toMatchObject({
      hash: newer.contentHash,
      model: 'test-embed',
      candidateId: 'nodeseek:1',
      cosine: 1,
      lexical: 1,
      canonicalHash: older.contentHash,
    });
    expect(visibleItems(state).map((item) => item.id)).toEqual(['nodeseek:1']);
    expect(removedItems(state)).toHaveProperty('nodeseek:2');
    expect(enrichmentRecords(state).map((record) => record.item.id)).toEqual(['nodeseek:1']);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(2);
  });

  it('flattens transitive matches onto the oldest root', async () => {
    const angle = Math.acos(0.83);
    const alpha = feedItem('nodeseek:1', { title: 'Alpha 主题', body: 'alpha body', publishedAt: NOW - 10800000 });
    const beta = feedItem('nodeseek:2', { title: 'Beta 主题', body: 'beta body', publishedAt: NOW - 7200000 });
    const gamma = feedItem('nodeseek:3', { title: 'Gamma 主题', body: 'gamma body', publishedAt: NOW - 3600000 });
    const state = makeState(alpha, beta, gamma);
    stubEmbedding(byMarker({
      Alpha: [Math.cos(0), Math.sin(0), 0, 0, 0, 0, 0, 0],
      Beta: [Math.cos(angle), Math.sin(angle), 0, 0, 0, 0, 0, 0],
      Gamma: [Math.cos(2 * angle), Math.sin(2 * angle), 0, 0, 0, 0, 0, 0],
    }));

    await runNodeSeekDedupe(config(), state, NOW);

    expect(state.records.get('nodeseek:2')!.duplicateOf).toBe('nodeseek:1');
    // P3 matched P2 before P2 was itself marked; the pointer is flattened so
    // there is never a P3 -> P2 -> P1 chain.
    expect(state.records.get('nodeseek:3')!.duplicateOf).toBe('nodeseek:1');
    expect(state.records.get('nodeseek:3')!.dedupe!.canonicalHash).toBe(alpha.contentHash);
    expect(visibleItems(state).map((item) => item.id)).toEqual(['nodeseek:1']);
    expect(removedItems(state)).toHaveProperty('nodeseek:2');
    expect(removedItems(state)).toHaveProperty('nodeseek:3');
  });

  it('does not hide when the lexical match fails the embedding check', async () => {
    const older = feedItem('nodeseek:1', { title: 'Alpha 同主题', body: '', publishedAt: NOW - 7200000 });
    const newer = feedItem('nodeseek:2', { title: 'Beta 同主题', body: '', publishedAt: NOW - 3600000 });
    const state = makeState(older, newer);
    stubEmbedding(byMarker({ Alpha: SAME, Beta: ORTHOGONAL }));

    const result = await runNodeSeekDedupe(config(), state, NOW);

    expect(result.duplicates).toBe(0);
    const marker = state.records.get('nodeseek:2')!.dedupe!;
    expect(state.records.get('nodeseek:2')!.duplicateOf).toBeUndefined();
    expect(marker.cosine).toBeUndefined();
    expect(marker.lexical).toBeCloseTo(0.6667, 4);
    expect(visibleItems(state)).toHaveLength(2);
  });

  it('fails open on an embedding outage and retries unmarked records next run', async () => {
    const older = feedItem('nodeseek:1', { title: 'Alpha 主题', body: '', publishedAt: NOW - 7200000 });
    const newer = feedItem('nodeseek:2', { title: 'Alpha 主题', body: '', publishedAt: NOW - 3600000 });
    const state = makeState(older, newer);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"unavailable"}', { status: 503 })));

    const failed = await runNodeSeekDedupe(config(), state, NOW);

    expect(failed).toMatchObject({ checked: 1, duplicates: 0, skipped: 1 });
    expect(state.records.get('nodeseek:2')!.dedupe).toBeUndefined();
    expect(visibleItems(state)).toHaveLength(2);

    stubEmbedding(byMarker({ Alpha: SAME }));
    const retried = await runNodeSeekDedupe(config(), state, NOW + 1000);
    expect(retried.duplicates).toBe(1);
    expect(state.records.get('nodeseek:2')!.duplicateOf).toBe('nodeseek:1');
  });

  it('does not re-embed records whose verdict is current', async () => {
    const older = feedItem('nodeseek:1', { title: 'Alpha 主题', body: '', publishedAt: NOW - 7200000 });
    const newer = feedItem('nodeseek:2', { title: 'Alpha 主题', body: '', publishedAt: NOW - 3600000 });
    const state = makeState(older, newer);
    const calls = stubEmbedding(byMarker({ Alpha: SAME }));

    await runNodeSeekDedupe(config(), state, NOW);
    const before = calls.length;
    const again = await runNodeSeekDedupe(config(), state, NOW + 1000);

    expect(again.checked).toBe(0);
    expect(calls).toHaveLength(before);
  });

  it('rechecks everything when the verdict fingerprint changes and releases a now-valid post', async () => {
    const older = feedItem('nodeseek:1', { title: 'Alpha 讨论区', body: '', publishedAt: NOW - 7200000 });
    const newer = feedItem('nodeseek:2', { title: 'Beta 讨论区', body: '', publishedAt: NOW - 3600000 });
    const state = makeState(older, newer);
    const angle = Math.acos(0.85);
    stubEmbedding(byMarker({ Alpha: SAME, Beta: [Math.cos(angle), Math.sin(angle), 0, 0, 0, 0, 0, 0] }));

    await runNodeSeekDedupe(config(), state, NOW);
    expect(state.records.get('nodeseek:2')!.duplicateOf).toBe('nodeseek:1');

    const strict = await runNodeSeekDedupe(config({ cosineThreshold: 0.9 }), state, NOW + 1000);

    expect(strict.duplicates).toBe(0);
    expect(state.records.get('nodeseek:2')!.duplicateOf).toBeUndefined();
    expect(state.records.get('nodeseek:2')!.dedupe!.config).toBe(dedupeFingerprint({ ...DEDUPE_DEFAULTS, enabled: true, cosineThreshold: 0.9 }));
    expect(visibleItems(state)).toHaveLength(2);
  });

  it('logs candidates in dry-run mode without touching state', async () => {
    const older = feedItem('nodeseek:1', { title: 'Alpha 主题', body: '', publishedAt: NOW - 7200000 });
    const newer = feedItem('nodeseek:2', { title: 'Alpha 主题', body: '', publishedAt: NOW - 3600000 });
    const state = makeState(older, newer);
    const calls = stubEmbedding(byMarker({ Alpha: SAME }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await runNodeSeekDedupe(config({ dryRun: true }), state, NOW);

    expect(result).toMatchObject({ duplicates: 1, dryRun: true });
    expect(state.records.get('nodeseek:2')!.duplicateOf).toBeUndefined();
    expect(state.records.get('nodeseek:2')!.dedupe).toBeUndefined();
    expect(visibleItems(state)).toHaveLength(2);
    expect(log.mock.calls.flat().join('\n')).toContain('[dedupe] would hide nodeseek:2 as nodeseek:1');
    expect(calls).toHaveLength(1);

    // No markers are written, so a dry-run repeats the comparison.
    await runNodeSeekDedupe(config({ dryRun: true }), state, NOW + 1000);
    expect(calls).toHaveLength(2);
    log.mockRestore();
  });

  it('clears every marker once on reset without embedding', async () => {
    const older = feedItem('nodeseek:1', { title: 'Alpha 主题', body: '', publishedAt: NOW - 7200000 });
    const newer = feedItem('nodeseek:2', { title: 'Alpha 主题', body: '', publishedAt: NOW - 3600000 });
    const state = makeState(older, newer);
    const duplicate = state.records.get('nodeseek:2')!;
    duplicate.duplicateOf = 'nodeseek:1';
    duplicate.dedupe = { hash: newer.contentHash, config: 'old', checkedAt: NOW, cosine: 1 };
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await runNodeSeekDedupe(config({ reset: true, enabled: false }), state, NOW);

    expect(result.reset).toBe(true);
    expect(duplicate.duplicateOf).toBeUndefined();
    expect(duplicate.dedupe).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('only compares posts inside the window and skips hidden candidates', async () => {
    const old = feedItem('nodeseek:1', { title: 'Alpha 主题', body: '', publishedAt: NOW - 8 * 86400000 });
    const fresh = feedItem('nodeseek:2', { title: 'Alpha 主题', body: '', publishedAt: NOW - 3600000 });
    const state = makeState(old, fresh);
    stubEmbedding(byMarker({ Alpha: SAME }));
    await runNodeSeekDedupe(config(), state, NOW);
    expect(fresh.id).toBe('nodeseek:2');
    expect(state.records.get('nodeseek:2')!.duplicateOf).toBeUndefined();
    expect(state.records.get('nodeseek:2')!.dedupe).toBeDefined();

    const hidden = feedItem('nodeseek:3', { title: 'Alpha 主题', body: '', publishedAt: NOW - 7200000 });
    const candidate = stored(hidden, { ruleHidden: true, item: { ...hidden, hidden: true } });
    const state2 = makeState(candidate, fresh);
    await runNodeSeekDedupe(config(), state2, NOW + 1000);
    expect(state2.records.get('nodeseek:2')!.duplicateOf).toBeUndefined();
  });

  it('never hides an older post because a newer one matches', async () => {
    const older = feedItem('nodeseek:1', { title: 'Alpha 主题', body: '', publishedAt: NOW - 7200000 });
    const newer = stored(feedItem('nodeseek:2', { title: 'Alpha 主题', body: '', publishedAt: NOW - 3600000 }), { moderation: 'hide' });
    const state = makeState(older, newer);
    stubEmbedding(byMarker({ Alpha: SAME }));

    await runNodeSeekDedupe(config(), state, NOW);

    expect(state.records.get('nodeseek:1')!.duplicateOf).toBeUndefined();
  });

  it('caps candidates and the per-run embedding budget', async () => {
    const items = Array.from({ length: 3 }, (_, index) => feedItem(`nodeseek:${index + 1}`, {
      title: '同一主题',
      body: '',
      publishedAt: NOW - (3 - index) * 3600000,
    }));
    const state = makeState(...items);
    const calls = stubEmbedding(() => SAME);

    const result = await runNodeSeekDedupe(config({ maxChecks: 1, maxCandidates: 1 }), state, NOW);

    expect(result.checked).toBe(1);
    expect(calls[0]).toHaveLength(2);
    expect(state.records.get('nodeseek:3')!.duplicateOf).toBe('nodeseek:1');
  });

  it('defers records that would exceed the text budget', async () => {
    const items = Array.from({ length: 3 }, (_, index) => feedItem(`nodeseek:${index + 1}`, {
      title: '同一主题',
      body: '',
      publishedAt: NOW - (3 - index) * 3600000,
    }));
    const state = makeState(...items);
    const calls = stubEmbedding(() => SAME);

    const result = await runNodeSeekDedupe(config({ maxChecks: 1, maxTexts: 2 }), state, NOW);

    expect(result).toMatchObject({ checked: 0, duplicates: 0, skipped: 1 });
    expect(state.records.get('nodeseek:3')!.dedupe).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('marks at most maxChecks posts per run and drains the rest later', async () => {
    const items = [
      feedItem('nodeseek:1', { title: 'Alpha compiler', body: '', publishedAt: NOW - 10800000 }),
      feedItem('nodeseek:2', { title: 'Beta database', body: '', publishedAt: NOW - 7200000 }),
      feedItem('nodeseek:3', { title: 'Gamma network', body: '', publishedAt: NOW - 3600000 }),
    ];
    const state = makeState(...items);
    const calls = stubEmbedding(() => SAME);

    const first = await runNodeSeekDedupe(config({ maxChecks: 2 }), state, NOW);
    expect(first.checked).toBe(2);
    expect([...state.records.values()].filter((record) => record.dedupe)).toHaveLength(2);
    expect(calls).toHaveLength(0);

    const second = await runNodeSeekDedupe(config({ maxChecks: 2 }), state, NOW + 1000);
    expect(second.checked).toBe(1);
    expect([...state.records.values()].every((record) => record.dedupe)).toBe(true);
  });
});

describe('embedding client', () => {
  function stubFetch(handler: (texts: string[]) => { status?: number; body: unknown }) {
    const calls: string[][] = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const texts = (JSON.parse(String(init?.body)) as { texts: string[] }).texts;
      calls.push(texts);
      const { status = 200, body } = handler(texts);
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }));
    return calls;
  }

  it('batches at 20 texts and validates every vector', async () => {
    const calls = stubFetch((texts) => ({
      body: { model: 'test-embed', dimensions: 8, embeddings: texts.map(() => SAME) },
    }));
    const result = await createEmbedder(config(), 20000)(Array.from({ length: 25 }, (_, index) => `text-${index}`));
    expect(calls.map((batch) => batch.length)).toEqual([20, 5]);
    expect(result.model).toBe('test-embed');
    expect(result.vectors).toHaveLength(25);
  });

  it('rejects short batches, bad dimensions and non-finite vectors', async () => {
    const failures: Array<{ dimensions: number; embeddings: unknown }> = [
      { dimensions: 8, embeddings: [SAME] },
      { dimensions: 4, embeddings: [[1, 2, 3, 4]] },
      { dimensions: 8, embeddings: [[1, 2, 3]] },
      { dimensions: 8, embeddings: [SAME.map(() => Number.NaN)] },
    ];
    for (const failure of failures) {
      stubFetch(() => ({ body: { model: 'test-embed', ...failure } }));
      await expect(createEmbedder(config(), 20000)(['a', 'b'])).rejects.toThrow();
    }
  });

  it('packs batches under the Worker 12,000-character total limit', async () => {
    const calls = stubFetch((texts) => ({
      body: { model: 'test-embed', dimensions: 8, embeddings: texts.map(() => SAME) },
    }));
    const result = await createEmbedder(config(), 20000)(['a'.repeat(6000), 'b'.repeat(6000), 'c'.repeat(6000)]);

    expect(calls.map((batch) => batch.length)).toEqual([2, 1]);
    expect(calls.map((batch) => batch.reduce((sum, text) => sum + text.length, 0))).toEqual([12000, 6000]);
    expect(result.vectors).toHaveLength(3);
  });

  it('drops blank texts and truncates single oversized inputs', async () => {
    const calls = stubFetch((texts) => ({
      body: { model: 'test-embed', dimensions: 8, embeddings: texts.map(() => SAME) },
    }));
    const result = await createEmbedder(config(), 20000)(['   ', 'x'.repeat(13000)]);

    expect(calls).toEqual([['x'.repeat(12000)]]);
    // The blank slot stays empty so callers leave that record unmarked.
    expect(result.vectors[0]).toBeUndefined();
    expect(result.vectors[1]).toEqual(SAME);
  });

  it('keeps earlier vectors when a later batch request fails', async () => {
    const calls = stubFetch((texts) => texts[0]!.startsWith('b-')
      ? { status: 503, body: { error: 'unavailable' } }
      : { body: { model: 'test-embed', dimensions: 8, embeddings: texts.map(() => SAME) } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const texts = [
      ...Array.from({ length: 20 }, (_, index) => `a-${index}`),
      ...Array.from({ length: 3 }, (_, index) => `b-${index}`),
    ];

    const result = await createEmbedder(config(), 20000)(texts);

    // The first batch succeeds; every later call is a retried b-batch attempt.
    expect(calls[0]).toHaveLength(20);
    expect(calls.slice(1).length).toBeGreaterThanOrEqual(1);
    expect(calls.slice(1).every((batch) => batch[0]!.startsWith('b-'))).toBe(true);
    for (const vector of result.vectors.slice(0, 20)) expect(vector).toEqual(SAME);
    expect(result.vectors.slice(20).every((vector) => vector === undefined)).toBe(true);
    expect(warn.mock.calls.flat().join('\n')).toContain('later batch failed');
    warn.mockRestore();
  });

  it('rejects a dimension change between batches', async () => {
    let call = 0;
    stubFetch((texts) => {
      call++;
      return { body: { model: 'test-embed', dimensions: call === 1 ? 8 : 16, embeddings: texts.map(() => call === 1 ? SAME : new Array(16).fill(0.5)) } };
    });
    await expect(createEmbedder(config(), 20000)(Array.from({ length: 21 }, (_, index) => `text-${index}`))).rejects.toThrow('dimensions');
  });
});

describe('canonical order', () => {
  it('prefers publication time, then first-seen time, then id', () => {
    const early = stored(feedItem('nodeseek:1', { publishedAt: NOW - 2000, firstSeenAt: NOW - 1000 }));
    const late = stored(feedItem('nodeseek:2', { publishedAt: NOW - 1000, firstSeenAt: NOW - 2000 }));
    expect(canonicalOrder(early, late)).toBeLessThan(0);
    const sameTime = stored(feedItem('nodeseek:1', { publishedAt: NOW, firstSeenAt: NOW }));
    const sameTimeLater = stored(feedItem('nodeseek:2', { publishedAt: NOW, firstSeenAt: NOW + 1 }));
    expect(canonicalOrder(sameTime, sameTimeLater)).toBeLessThan(0);
  });
});
