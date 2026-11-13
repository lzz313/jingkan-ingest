import * as cheerio from 'cheerio';
import type { CorePost, ItemMetrics, NormalizedItem, SourceId } from '../../shared/types';
import { firstSentences, hashText, stripHtml } from '../../shared/html';
import { parseMetricNumber, snowflakeToMs } from '../../shared/numbers';
import { fetchJson, fetchText } from '../fetch';

const POSTS_URL = 'https://xbangdan.com/posts/';
const HOT_URL = 'https://xbangdan.com/hot.json';
const MAX_ITEMS = 30;

interface HotEntry {
  id?: string;
  h?: string;
  n?: string;
  t?: string;
  v?: number;
  r?: number;
  l?: number;
  age?: number;
  c?: string | null;
  /** Older hot.json payloads used `cat`; keep accepting it as a fallback. */
  cat?: string | null;
}

interface HotPayload {
  rate?: HotEntry[];
  views?: HotEntry[];
}

interface Candidate {
  id: string;
  url?: string;
  handle?: string;
  displayName?: string;
  text?: string;
  category?: string;
  ageHours?: number;
  views?: number;
  viewsPerHour?: number;
  likes?: number;
}

function finiteMetric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

function finiteAge(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function cleanHandle(value: string | undefined): string | undefined {
  const handle = value?.trim().replace(/^@/, '');
  return handle && /^[a-z0-9_]+$/i.test(handle) ? handle : undefined;
}

function cleanText(value: string | undefined): string | undefined {
  const text = stripHtml(value).replace(/\s+/g, ' ').trim();
  return text || undefined;
}

function mergeCategories(
  left: string | undefined,
  right: string | null | undefined,
): string | undefined {
  const categories = new Set(
    `${left ?? ''} ${right ?? ''}`
      .split(/\s+/)
      .map((value) => value.trim())
      .filter((value) => value && value !== 'none'),
  );
  return categories.size > 0 ? [...categories].join(' ') : undefined;
}

function mergeCandidate(
  previous: Candidate | undefined,
  next: Candidate,
): Candidate {
  if (!previous) return next;
  return {
    id: previous.id,
    url: previous.url ?? next.url,
    handle: next.handle ?? previous.handle,
    displayName: next.displayName ?? previous.displayName,
    text: next.text ?? previous.text,
    category: mergeCategories(previous.category, next.category),
    ageHours: next.ageHours ?? previous.ageHours,
    views: next.views ?? previous.views,
    viewsPerHour: next.viewsPerHour ?? previous.viewsPerHour,
    likes: next.likes ?? previous.likes,
  };
}

function handleFromXUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^(?:www\.|mobile\.)/, '');
    if (host !== 'x.com' && host !== 'twitter.com') return undefined;
    return cleanHandle(parsed.pathname.split('/').filter(Boolean)[0]);
  } catch {
    return undefined;
  }
}

function normalizeStatusUrl(
  rawUrl: string | undefined,
  id: string,
  handle: string | undefined,
): string {
  if (rawUrl) {
    try {
      const url = new URL(rawUrl);
      url.protocol = 'https:';
      url.hostname = 'x.com';
      if (url.pathname.includes(`/status/${id}`)) {
        url.search = '';
        url.hash = '';
        return url.toString().replace(/\/$/, '');
      }
    } catch {
      // Fall through to the canonical status URL.
    }
  }
  return handle
    ? `https://x.com/${handle}/status/${id}`
    : `https://x.com/i/web/status/${id}`;
}

function parsePostsHtml(html: string): Map<string, Candidate> {
  const $ = cheerio.load(html);
  const candidates = new Map<string, Candidate>();

  $('.pc-b[data-hot] a.prow[data-id]').each((_, element) => {
    const row = $(element);
    const id = (row.attr('data-id') ?? '').trim();
    if (!/^\d+$/.test(id)) return;

    const url = row.attr('href');
    const handle = handleFromXUrl(url);
    const social = row.find('.s').first().text().replace(/\s+/g, ' ').trim();
    const socialParts = social.split('·');
    const displayName = socialParts[0]?.trim() || undefined;
    const likes = parseMetricNumber(social.match(/([\d.,]+\s*[万wWkKmM亿]?)\s*赞/i)?.[1]);

    candidates.set(id, {
      id,
      url,
      handle,
      displayName,
      text: cleanText(row.find('.n').first().text()),
      category: row.attr('data-cat')?.trim() || undefined,
      ageHours: finiteAge(Number(row.attr('data-age'))),
      likes,
    });
  });

  return candidates;
}

function addHotEntries(candidates: Map<string, Candidate>, payload: HotPayload): void {
  const seen = new Set<string>();
  for (const entry of [...(payload.rate ?? []), ...(payload.views ?? [])]) {
    const id = entry.id?.trim();
    if (!id || !/^\d+$/.test(id) || seen.has(id)) continue;
    seen.add(id);

    const next: Candidate = {
      id,
      handle: cleanHandle(entry.h),
      displayName: cleanText(entry.n),
      text: cleanText(entry.t),
      category: entry.c ?? entry.cat ?? undefined,
      ageHours: finiteAge(entry.age),
      views: finiteMetric(entry.v),
      viewsPerHour: finiteMetric(entry.r),
      likes: finiteMetric(entry.l),
    };
    candidates.set(id, mergeCandidate(candidates.get(id), next));
  }
}

function hasAiCoding(category: string | undefined): boolean {
  return Boolean(category?.split(/\s+/).includes('ai_coding'));
}

function toItem(candidate: Candidate, now: number): NormalizedItem | null {
  if (!candidate.text || !hasAiCoding(candidate.category)) return null;
  const ageMs =
    candidate.ageHours !== undefined ? Math.max(0, candidate.ageHours * 60 * 60_000) : null;
  const publishedAt =
    snowflakeToMs(candidate.id) ?? (ageMs !== null ? now - ageMs : now);
  const url = normalizeStatusUrl(candidate.url, candidate.id, candidate.handle);
  const title = firstSentences(candidate.text, 110);
  if (!title) return null;

  const metrics: ItemMetrics = {};
  if (candidate.views !== undefined) metrics.views = candidate.views;
  if (candidate.likes !== undefined) metrics.likes = candidate.likes;
  if (candidate.viewsPerHour !== undefined) {
    metrics.viewsPerHour = candidate.viewsPerHour;
  }

  const category = 'AI 编程';
  const corePost: CorePost = {
    url,
    label: firstSentences(candidate.text, 90),
    handle: candidate.handle,
    views: candidate.views,
    likes: candidate.likes,
  };

  return {
    source: 'x' as SourceId,
    externalId: candidate.id,
    storyKey: candidate.id,
    title,
    body: candidate.text.slice(0, 20_000),
    brief: firstSentences(candidate.text, 220),
    url,
    author: candidate.displayName || candidate.handle,
    authorHandle: candidate.handle,
    publishedAt,
    metrics,
    images: [],
    extra: {
      category,
      categories: candidate.category?.split(/\s+/).filter(Boolean) ?? [category],
      sourceCategory: 'ai_coding',
      corePosts: [corePost],
      viewsPerHour: candidate.viewsPerHour,
      timeSource: 'post',
      statsSource: 'xbangdan',
    },
    contentHash: hashText(`${candidate.text}\n${url}`),
  };
}

export async function fetchX(now = Date.now()): Promise<NormalizedItem[]> {
  const [postsResult, hotResult] = await Promise.allSettled([
    fetchText(POSTS_URL, {
      headers: { accept: 'text/html,application/xhtml+xml' },
    }),
    fetchJson<HotPayload>(HOT_URL),
  ]);

  const candidates = new Map<string, Candidate>();
  if (postsResult.status === 'fulfilled') {
    for (const [id, candidate] of parsePostsHtml(postsResult.value)) {
      candidates.set(id, mergeCandidate(candidates.get(id), candidate));
    }
  }
  if (hotResult.status === 'fulfilled') {
    addHotEntries(candidates, hotResult.value);
  }

  if (postsResult.status === 'rejected' && hotResult.status === 'rejected') {
    const postsError =
      postsResult.reason instanceof Error ? postsResult.reason.message : String(postsResult.reason);
    const hotError =
      hotResult.reason instanceof Error ? hotResult.reason.message : String(hotResult.reason);
    throw new Error(`xbangdan posts and hot.json both failed: ${postsError}; ${hotError}`);
  }

  const items = [...candidates.values()]
    .sort(
      (left, right) =>
        (right.views ?? 0) - (left.views ?? 0) ||
        (right.viewsPerHour ?? 0) - (left.viewsPerHour ?? 0) ||
        (snowflakeToMs(right.id) ?? 0) - (snowflakeToMs(left.id) ?? 0),
    )
    .map((candidate) => toItem(candidate, now))
    .filter((item): item is NormalizedItem => item !== null)
    .slice(0, MAX_ITEMS);

  if (items.length === 0) {
    throw new Error('xbangdan returned no AI coding posts');
  }
  return items;
}
