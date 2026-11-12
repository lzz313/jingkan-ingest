import type { NormalizedItem } from '../../shared/types';
import { extractImages, firstSentences, hashText, stripHtml } from '../../shared/html';
import { fetchJson } from '../fetch';

interface AlgoliaHit {
  objectID: string;
  title?: string | null;
  url?: string | null;
  author?: string | null;
  created_at_i?: number;
  points?: number | null;
  num_comments?: number | null;
  story_text?: string | null;
}

interface AlgoliaResponse {
  hits: AlgoliaHit[];
  nbHits: number;
}

function mapHit(hit: AlgoliaHit): NormalizedItem | null {
  if (!hit.objectID || !hit.title) return null;
  const hnUrl = `https://news.ycombinator.com/item?id=${hit.objectID}`;
  const url = hit.url || hnUrl;
  const body = stripHtml(hit.story_text);
  return {
    source: 'hn',
    externalId: hit.objectID,
    title: hit.title,
    body,
    brief: firstSentences(body, 170),
    url,
    author: hit.author ?? undefined,
    publishedAt: (hit.created_at_i ?? Math.floor(Date.now() / 1000)) * 1000,
    metrics: {
      points: hit.points ?? 0,
      comments: hit.num_comments ?? 0,
    },
    images: extractImages(hit.story_text, url),
    extra: {
      hnUrl,
      timeSource: 'post',
    },
    contentHash: hashText(`${hit.title}\n${body}\n${url}`),
  };
}

export async function fetchHn(): Promise<NormalizedItem[]> {
  const since = Math.floor(Date.now() / 1000) - 36 * 3600;
  const recentUrl = new URL('https://hn.algolia.com/api/v1/search_by_date');
  recentUrl.searchParams.set('tags', 'story');
  recentUrl.searchParams.set('numericFilters', `created_at_i>${since},points>=10`);
  recentUrl.searchParams.set('hitsPerPage', '50');

  // The front page holds ~30 stories, ordered by HN's rank. A freshly promoted
  // story sits at the bottom with only a few points, so the old default page
  // size of 20 truncated exactly the newest entries and the feed looked frozen
  // between the `points>=10` milestones.
  const frontPageUrl = new URL('https://hn.algolia.com/api/v1/search');
  frontPageUrl.searchParams.set('tags', 'front_page');
  frontPageUrl.searchParams.set('hitsPerPage', '50');

  const results = await Promise.allSettled([
    fetchJson<AlgoliaResponse>(frontPageUrl.toString()),
    fetchJson<AlgoliaResponse>(recentUrl.toString()),
  ]);

  const hits: AlgoliaHit[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') hits.push(...result.value.hits);
  }
  if (hits.length === 0) {
    const reason = results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
    throw reason?.reason ?? new Error('Hacker News returned no stories');
  }

  const seen = new Set<string>();
  const items: NormalizedItem[] = [];
  for (const hit of hits) {
    if (seen.has(hit.objectID)) continue;
    const item = mapHit(hit);
    if (!item) continue;
    seen.add(hit.objectID);
    items.push(item);
  }

  return items.sort((a, b) => b.publishedAt - a.publishedAt);
}
