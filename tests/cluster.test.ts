import { afterEach, describe, expect, it, vi } from 'vitest';
import { clusterFingerprint, runCrossSourceClusters } from '../src/ingest/cluster';
import {
  CLUSTER_DEFAULTS,
  DEDUPE_DEFAULTS,
  loadClusterConfig,
  type ClusterConfig,
  type IngestConfig,
} from '../src/ingest/env';
import {
  reconcileClusterPointers,
  removedItems,
  visibleItems,
  type GeneratorState,
  type StoredItem,
} from '../src/ingest/state';
import type { FeedItem, SourceId } from '../src/shared/types';

const NOW = Date.UTC(2026, 10, 15, 2);
const SAME = [1, 0, 0, 0, 0, 0, 0, 0];
const ORTHOGONAL = [0, 0, 0, 0, 0, 0, 0, 1];

function feedItem(id: string, overrides: Partial<FeedItem> = {}): FeedItem {
  const [source, externalId] = id.split(':') as [SourceId, string];
  return {
    id,
    source,
    externalId,
    storyKey: null,
    title: id,
    titleZh: null,
    body: `body ${id}`,
    brief: null,
    briefZh: null,
    bodyZh: null,
    url: `https://${source}.example.com/${externalId}`,
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

function makeState(...items: FeedItem[]): GeneratorState {
  const records = items.map((item): StoredItem => ({
    item, observedAt: NOW, ruleHidden: false, moderation: 'keep',
  }));
  return {
    records: new Map(records.map((record) => [record.item.id, record])),
    sources: {}, lastUpdated: 0, lastRefreshAt: 0, lastIngestAttemptAt: 0,
  };
}

function config(cluster: Partial<ClusterConfig> = {}): IngestConfig {
  return {
    baseUrl: 'https://jing.show',
    ingestToken: 'test',
    prewarmTranslations: false,
    dedupe: DEDUPE_DEFAULTS,
    cluster: { ...CLUSTER_DEFAULTS, enabled: true, ...cluster },
  };
}

function stubEmbedding(embedding: (text: string) => number[]) {
  const calls: string[][] = [];
  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const texts = (JSON.parse(String(init?.body)) as { texts: string[] }).texts;
    calls.push(texts);
    return new Response(JSON.stringify({
      model: 'test-embed', dimensions: 8, embeddings: texts.map(embedding),
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  return calls;
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('cross-source merge signals', () => {
  it('merges on a shared article URL without spending an embedding call', async () => {
    const older = feedItem('hn:1', {
      title: 'Show HN: Acme launch',
      url: 'https://news.ycombinator.com/item?id=1',
      extra: { articleUrl: 'https://acme.dev/launch' },
      publishedAt: NOW - 7200000,
    });
    const newer = feedItem('v2ex:2', {
      title: 'Acme 上线',
      body: '官网 https://acme.dev/launch?utm_source=v2ex',
      publishedAt: NOW - 3600000,
    });
    const state = makeState(older, newer);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await runCrossSourceClusters(config(), state, NOW);

    expect(result).toMatchObject({ checked: 2, clusters: 1, skipped: 0, dryRun: false, reset: false });
    const duplicate = state.records.get('v2ex:2')!;
    expect(duplicate.clusterOf).toBe('hn:1');
    expect(duplicate.cluster?.sharedUrl).toBe('acme.dev/launch');
    expect(duplicate.cluster?.canonicalHash).toBe(older.contentHash);
    expect(fetchMock).not.toHaveBeenCalled();

    const visible = visibleItems(state);
    expect(visible.map((item) => item.id)).toEqual(['hn:1', 'v2ex:2']);
    expect(visible.find((item) => item.id === 'v2ex:2')?.clusterOf).toBe('hn:1');
    expect(visible.find((item) => item.id === 'hn:1')?.related).toEqual([{
      id: 'v2ex:2', source: 'v2ex', title: 'Acme 上线', titleZh: null,
      url: 'https://v2ex.example.com/2', author: null, publishedAt: NOW - 3600000,
    }]);
    // A merged favourite must stay resolvable, so it is not a removal.
    expect(removedItems(state)).toEqual({});
  });

  it('does not spend embeddings when a shared link already confirms', async () => {
    const older = feedItem('hn:1', {
      title: 'Acme launch',
      url: 'https://news.ycombinator.com/item?id=1',
      extra: { articleUrl: 'https://acme.dev/launch' },
      publishedAt: NOW - 7200000,
    });
    const lexical = feedItem('v2ex:2', {
      title: 'Acme launch', body: 'A discussion thread', publishedAt: NOW - 5400000,
    });
    const newer = feedItem('linuxdo:3', {
      title: 'Acme launch', body: '官网 https://acme.dev/launch', publishedAt: NOW - 3600000,
    });
    const state = makeState(older, lexical, newer);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    // Only the newest record is queued. A lexical-only candidate exists, but
    // the shared link is self-confirming: it must neither trigger nor consume
    // an embedding call.
    const result = await runCrossSourceClusters(config({ maxChecks: 1 }), state, NOW);

    expect(result.clusters).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.records.get('linuxdo:3')!.clusterOf).toBe('hn:1');
    expect(state.records.get('linuxdo:3')!.cluster!.sharedUrl).toBe('acme.dev/launch');
  });

  it('uses translation text and embeddings for a same-language-free match', async () => {
    const older = feedItem('hn:1', {
      title: 'A new open-source database for small teams',
      titleZh: '面向小团队的新开源数据库',
      body: 'The project is available today.',
      publishedAt: NOW - 7200000,
    });
    const newer = feedItem('v2ex:2', {
      title: '面向小团队的新开源数据库',
      body: '今天发布了。',
      publishedAt: NOW - 3600000,
    });
    const state = makeState(older, newer);
    const calls = stubEmbedding(() => SAME);

    const result = await runCrossSourceClusters(config(), state, NOW);

    expect(result.clusters).toBe(1);
    expect(calls).toHaveLength(1);
    expect(state.records.get('v2ex:2')!.clusterOf).toBe('hn:1');
    expect(state.records.get('v2ex:2')!.cluster!.cosine).toBe(1);
    expect(state.records.get('v2ex:2')!.cluster!.model).toBe('test-embed');
  });

  it('leaves similar titles separate when the embedding verdict is below threshold', async () => {
    const older = feedItem('hn:1', {
      title: 'Acme compiler launch', body: 'A compiler for teams', publishedAt: NOW - 7200000,
    });
    const newer = feedItem('v2ex:2', {
      title: 'Acme compiler launch notes', body: 'Release notes for the compiler', publishedAt: NOW - 3600000,
    });
    const state = makeState(older, newer);
    stubEmbedding((text) => text.includes('notes') ? ORTHOGONAL : SAME);

    const result = await runCrossSourceClusters(config(), state, NOW);

    expect(result.clusters).toBe(0);
    expect(state.records.get('v2ex:2')!.clusterOf).toBeUndefined();
    expect(state.records.get('v2ex:2')!.cluster!.cosine).toBeUndefined();
    expect(visibleItems(state)).toHaveLength(2);
  });

  it('does not treat a generic Latin token like AI as a cross-source match', async () => {
    const older = feedItem('hn:1', {
      title: '国行 mac 没有全功能 ai，但是 ai 的 bug 一个不少',
      body: '', publishedAt: NOW - 7200000,
    });
    const newer = feedItem('linuxdo:2', {
      title: '学AI，上L站', body: '', publishedAt: NOW - 3600000,
    });
    const state = makeState(older, newer);
    // A real embedding match here would merge; the prefilter must not ask.
    const calls = stubEmbedding(() => SAME);

    const result = await runCrossSourceClusters(config(), state, NOW);

    expect(result.clusters).toBe(0);
    expect(calls).toHaveLength(0);
    expect(state.records.get('linuxdo:2')!.clusterOf).toBeUndefined();
  });

  it('bridges a translated title through a distinctive product token', async () => {
    const older = feedItem('hn:1', {
      title: 'Cloudflare launches a new developer platform',
      body: '', publishedAt: NOW - 7200000,
    });
    const newer = feedItem('v2ex:2', {
      title: 'Cloudflare 新开发者平台体验', body: '', publishedAt: NOW - 3600000,
    });
    const state = makeState(older, newer);
    const calls = stubEmbedding(() => SAME);

    const result = await runCrossSourceClusters(config(), state, NOW);

    expect(result.clusters).toBe(1);
    expect(calls).toHaveLength(1);
    expect(state.records.get('v2ex:2')!.clusterOf).toBe('hn:1');
  });

  it('releases a child that would otherwise share the new root source', async () => {
    const root = feedItem('hn:1', {
      title: 'Acme compiler launch', body: 'A compiler for teams', publishedAt: NOW - 3 * 3600000,
    });
    const bridge = feedItem('v2ex:2', {
      title: 'Acme compiler launch', body: 'A compiler for teams', publishedAt: NOW - 2 * 3600000,
    });
    const child = feedItem('hn:3', {
      title: 'Acme compiler launch', body: 'A compiler for teams', publishedAt: NOW - 3600000,
    });
    const state = makeState(root, bridge, child);
    const childRecord = state.records.get('hn:3')!;
    childRecord.clusterOf = 'v2ex:2';
    childRecord.cluster = { hash: child.contentHash, config: 'old', checkedAt: NOW };
    stubEmbedding(() => SAME);

    await runCrossSourceClusters(config(), state, NOW);

    expect(state.records.get('v2ex:2')!.clusterOf).toBe('hn:1');
    // Following the bridge into an HN root would make an HN→HN related link.
    expect(childRecord.clusterOf).toBeUndefined();
    expect(visibleItems(state).map((item) => item.id).sort()).toEqual(['hn:1', 'hn:3', 'v2ex:2']);
    expect(visibleItems(state).find((item) => item.id === 'hn:1')?.related?.map((entry) => entry.source)).toEqual(['v2ex']);
  });

  it('never merges two posts from the same source', async () => {
    const older = feedItem('v2ex:1', {
      title: '同一个主题', url: 'https://www.v2ex.com/t/1', publishedAt: NOW - 7200000,
    });
    const newer = feedItem('v2ex:2', {
      title: '同一个主题', url: 'https://www.v2ex.com/t/2', publishedAt: NOW - 3600000,
    });
    const state = makeState(older, newer);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await runCrossSourceClusters(config(), state, NOW);

    expect(state.records.get('v2ex:2')!.clusterOf).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('only compares records inside the window and never revives an older item', async () => {
    const old = feedItem('hn:1', {
      title: 'Acme compiler launch', body: 'A compiler for teams', publishedAt: NOW - 4 * 86400000,
    });
    const fresh = feedItem('v2ex:2', {
      title: 'Acme compiler launch', body: 'A compiler for teams', publishedAt: NOW - 3600000,
    });
    const state = makeState(old, fresh);
    stubEmbedding(() => SAME);

    await runCrossSourceClusters(config(), state, NOW);

    expect(fresh.id).toBe('v2ex:2');
    expect(state.records.get('v2ex:2')!.clusterOf).toBeUndefined();
    expect(state.records.get('hn:1')!.clusterOf).toBeUndefined();
  });
});

describe('cluster safety switches', () => {
  it('logs a dry-run merge without touching state', async () => {
    const older = feedItem('hn:1', {
      title: 'Show HN: Acme', extra: { articleUrl: 'https://acme.dev/launch' },
      publishedAt: NOW - 7200000,
    });
    const newer = feedItem('v2ex:2', {
      title: 'Acme 上线', body: 'https://acme.dev/launch', publishedAt: NOW - 3600000,
    });
    const state = makeState(older, newer);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await runCrossSourceClusters(config({ dryRun: true }), state, NOW);

    expect(result).toMatchObject({ clusters: 1, dryRun: true });
    expect(state.records.get('v2ex:2')!.clusterOf).toBeUndefined();
    expect(state.records.get('v2ex:2')!.cluster).toBeUndefined();
    expect(log.mock.calls.flat().join('\n')).toContain('[cluster] would merge v2ex:2 into hn:1');
  });

  it('fails open on an embedding outage and retries the unmarked record', async () => {
    const older = feedItem('hn:1', {
      title: 'Acme compiler launch', body: 'A compiler for teams', publishedAt: NOW - 7200000,
    });
    const newer = feedItem('v2ex:2', {
      title: 'Acme compiler launch', body: 'A compiler for teams', publishedAt: NOW - 3600000,
    });
    const state = makeState(older, newer);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"unavailable"}', { status: 503 })));

    const failed = await runCrossSourceClusters(config(), state, NOW);

    expect(failed).toMatchObject({ clusters: 0, skipped: 1 });
    expect(state.records.get('v2ex:2')!.cluster).toBeUndefined();

    stubEmbedding(() => SAME);
    const retried = await runCrossSourceClusters(config(), state, NOW + 1000);
    expect(retried.clusters).toBe(1);
    expect(state.records.get('v2ex:2')!.clusterOf).toBe('hn:1');
  });

  it('rechecks after a fingerprint change and releases a merge that no longer qualifies', async () => {
    const older = feedItem('hn:1', {
      title: 'Acme compiler launch', body: 'A compiler for teams', publishedAt: NOW - 7200000,
    });
    const newer = feedItem('v2ex:2', {
      title: 'Acme compiler launch notes', body: 'Release notes for the compiler', publishedAt: NOW - 3600000,
    });
    const state = makeState(older, newer);
    stubEmbedding(() => SAME);
    await runCrossSourceClusters(config(), state, NOW);
    expect(state.records.get('v2ex:2')!.clusterOf).toBe('hn:1');

    vi.unstubAllGlobals();
    stubEmbedding((text) => text.includes('notes') ? ORTHOGONAL : SAME);
    const strict = await runCrossSourceClusters(config({ cosineThreshold: 0.95 }), state, NOW + 1000);

    expect(strict.clusters).toBe(0);
    expect(state.records.get('v2ex:2')!.clusterOf).toBeUndefined();
    // The marker records the stricter settings, so the next run does not repeat.
    expect(state.records.get('v2ex:2')!.cluster!.config).toBe(
      clusterFingerprint({ ...CLUSTER_DEFAULTS, enabled: true, cosineThreshold: 0.95 }),
    );
    expect(visibleItems(state)).toHaveLength(2);
  });

  it('clears every marker once on reset without embedding', async () => {
    const root = feedItem('hn:1');
    const child = feedItem('v2ex:2');
    const state = makeState(root, child);
    const record = state.records.get('v2ex:2')!;
    record.clusterOf = 'hn:1';
    record.cluster = { hash: child.contentHash, config: 'old', checkedAt: NOW };
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await runCrossSourceClusters(config({ reset: true, enabled: false }), state, NOW);

    expect(result.reset).toBe(true);
    expect(record.clusterOf).toBeUndefined();
    expect(record.cluster).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reads switches from the environment and clamps malformed values', () => {
    expect(loadClusterConfig({})).toEqual(CLUSTER_DEFAULTS);
    expect(loadClusterConfig({
      CROSS_SOURCE_CLUSTER: '1',
      CROSS_SOURCE_CLUSTER_COSINE: '0.95',
      CROSS_SOURCE_CLUSTER_WINDOW_DAYS: '99',
    })).toMatchObject({ enabled: true, cosineThreshold: 0.95, windowDays: 14 });
  });
});

describe('cluster pointer reconciliation', () => {
  function pointerState() {
    const root = feedItem('hn:1', { publishedAt: NOW - 7200000 });
    const child = feedItem('v2ex:2', { publishedAt: NOW - 3600000 });
    const state = makeState(root, child);
    const record = state.records.get('v2ex:2')!;
    record.clusterOf = 'hn:1';
    record.cluster = { hash: child.contentHash, config: 'fp', checkedAt: NOW, canonicalHash: root.contentHash };
    return { state, root: state.records.get('hn:1')!, child: record };
  }

  it('keeps a pointer while the root stays visible', () => {
    const { state, child } = pointerState();
    expect(reconcileClusterPointers(state)).toBe(0);
    expect(child.clusterOf).toBe('hn:1');
  });

  it('releases a pointer when the root is pruned, hidden or rewritten', () => {
    const mutations: Array<(state: GeneratorState) => void> = [
      (state) => { state.records.delete('hn:1'); },
      (state) => { state.records.get('hn:1')!.ruleHidden = true; },
      (state) => { state.records.get('hn:1')!.moderation = 'hide'; },
      (state) => { state.records.get('hn:1')!.item.contentHash = 'rewritten'; },
    ];
    for (const mutate of mutations) {
      const { state, child } = pointerState();
      mutate(state);
      expect(reconcileClusterPointers(state)).toBe(1);
      expect(child.clusterOf).toBeUndefined();
      expect(child.cluster).toBeUndefined();
    }
  });
});
