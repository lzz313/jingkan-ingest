import type { NormalizedItem } from '../../shared/types';
import { extractImages, firstSentences, hashText, stripHtml } from '../../shared/html';
import { mapLimit } from '../async';
import { fetchJson } from '../fetch';

const API_BASE = 'https://hacker-news.firebaseio.com/v0';
const NEW_STORIES_LIMIT = 30;
const TOP_STORIES_LIMIT = 40;
const ITEM_CONCURRENCY = 8;
const LIST_OPTIONS = { timeoutMs: 15_000 };
const ITEM_OPTIONS = { retries: 0, timeoutMs: 8_000 };

interface FirebaseHnItem {
  id?: number;
  type?: string;
  deleted?: boolean;
  dead?: boolean;
  by?: string;
  time?: number;
  title?: string;
  text?: string;
  url?: string;
  score?: number;
  descendants?: number;
}

function storyIds(payload: unknown, limit: number): number[] {
  if (!Array.isArray(payload)) return [];
  return payload.filter((id): id is number => Number.isInteger(id)).slice(0, limit);
}

function mapItem(item: FirebaseHnItem | null): NormalizedItem | null {
  if (!item || typeof item !== 'object') return null;
  if (item.deleted || item.dead || item.type !== 'story') return null;
  if (!Number.isInteger(item.id) || !item.title?.trim()) return null;
  if (typeof item.by !== 'string' || !Number.isFinite(item.time)) return null;

  const id = item.id as number;
  const title = stripHtml(item.title);
  if (!title) return null;
  const hnUrl = `https://news.ycombinator.com/item?id=${id}`;
  // Cards link to the Y Combinator discussion, not the submitted article.
  // Keep hashing (and resolving images against) the article URL so a story
  // that has not changed keeps the same content hash across this switch.
  const sourceUrl = item.url || hnUrl;
  const body = stripHtml(item.text ?? '');

  return {
    source: 'hn',
    externalId: String(id),
    title,
    body,
    brief: firstSentences(body, 170),
    url: hnUrl,
    author: item.by,
    publishedAt: (item.time as number) * 1000,
    metrics: {
      points: item.score ?? 0,
      comments: item.descendants ?? 0,
    },
    images: extractImages(item.text, sourceUrl),
    extra: {
      hnUrl,
      timeSource: 'post',
    },
    contentHash: hashText(`${title}\n${body}\n${sourceUrl}`),
  };
}

export async function fetchHn(): Promise<NormalizedItem[]> {
  const results = await Promise.allSettled([
    fetchJson<number[]>(`${API_BASE}/newstories.json`, LIST_OPTIONS),
    fetchJson<number[]>(`${API_BASE}/topstories.json`, LIST_OPTIONS),
  ]);
  const [newResult, topResult] = results;

  if (newResult.status === 'rejected' && topResult.status === 'rejected') {
    throw newResult.reason ?? topResult.reason ?? new Error('Hacker News lists both failed');
  }
  if (newResult.status === 'rejected' || topResult.status === 'rejected') {
    console.warn(
      `Hacker News partial list fetch: new=${newResult.status}, top=${topResult.status}`,
    );
  }

  const newIds = newResult.status === 'fulfilled' ? storyIds(newResult.value, NEW_STORIES_LIMIT) : [];
  const topIds = topResult.status === 'fulfilled' ? storyIds(topResult.value, TOP_STORIES_LIMIT) : [];
  const ids = [...new Set([...newIds, ...topIds])];

  let skipped = 0;
  const mapped = await mapLimit(ids, ITEM_CONCURRENCY, async (id) => {
    try {
      const item = await fetchJson<FirebaseHnItem | null>(
        `${API_BASE}/item/${id}.json`,
        ITEM_OPTIONS,
      );
      const story = mapItem(item);
      if (!story) skipped++;
      return story;
    } catch {
      skipped++;
      return null;
    }
  });

  if (skipped > 0) {
    console.warn(`Hacker News skipped ${skipped} of ${ids.length} stories`);
  }

  const stories = mapped.filter((item): item is NormalizedItem => Boolean(item));
  if (stories.length === 0) throw new Error('Hacker News returned no stories');

  return stories.sort(
    (a, b) =>
      b.publishedAt - a.publishedAt || Number(b.externalId) - Number(a.externalId),
  );
}
