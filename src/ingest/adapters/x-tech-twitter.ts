import type { CorePost, ItemMetrics, NormalizedItem } from '../../shared/types';
import { firstSentences, hashText, stripHtml } from '../../shared/html';
import { mapLimit } from '../async';
import { fetchJson } from '../fetch';
import { isWithinRecentWindow } from '../time-window';

export const TECH_TWITTER_TRENDING_URL =
  'https://www.techtwitter.com/api/tweets/trending?limit=50&offset=0';
export const MAX_TECH_TWITTER_ITEMS = 10;

interface TechTwitterEntry {
  id?: string;
  x_post_id?: string;
  x_url?: string;
  headline?: string;
  summary?: string;
  topics?: unknown;
  quality_score?: number;
  posted_at?: string;
  canonical_url?: string;
  content_type?: string;
}

interface TechTwitterPayload {
  tweets?: TechTwitterEntry[];
}

interface TechTwitterPost {
  id: string;
  xUrl: string;
  headline: string;
  summary: string;
  topics: string[];
  qualityScore?: number;
  postedAt: number;
  canonicalUrl?: string;
}

interface SyndicationUser {
  name?: string;
  screen_name?: string;
}

interface SyndicationPhoto {
  url?: string;
  media_url_https?: string;
}

interface SyndicationTweet {
  text?: string;
  full_text?: string;
  note_tweet?: {
    note_tweet_results?: {
      result?: {
        text?: string;
      };
    };
  };
  favorite_count?: number;
  conversation_count?: number;
  created_at?: string;
  user?: SyndicationUser;
  photos?: SyndicationPhoto[] | number;
  mediaDetails?: Array<SyndicationPhoto & { type?: string }>;
  video?: { poster?: string };
}

interface EnrichedTechTwitterPost {
  text?: string;
  handle?: string;
  displayName?: string;
  publishedAt?: number;
  likes?: number;
  replies?: number;
  images: string[];
}

function finiteMetric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

function cleanText(value: string | undefined): string {
  return stripHtml(value).replace(/\s+/g, ' ').trim();
}

function cleanHandle(value: string | undefined): string | undefined {
  const handle = value?.trim().replace(/^@/, '');
  return handle && /^[a-z0-9_]+$/i.test(handle) ? handle : undefined;
}

function parseTime(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function addImage(images: string[], value: string | undefined): void {
  if (!value || !/^https?:\/\//i.test(value) || images.includes(value)) return;
  images.push(value);
}

function syndicationToken(id: string): string {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
}

function normalizedXUrl(id: string, handle: string | undefined): string {
  return handle
    ? `https://x.com/${handle}/status/${id}`
    : `https://x.com/i/web/status/${id}`;
}

function parseTechPosts(payload: TechTwitterPayload, now: number): TechTwitterPost[] {
  const seen = new Set<string>();
  const posts: TechTwitterPost[] = [];
  for (const entry of payload.tweets ?? []) {
    const id = entry.x_post_id?.trim();
    if (!id || !/^\d+$/.test(id) || seen.has(id)) continue;
    if (entry.content_type && entry.content_type !== 'tweet') continue;

    const postedAt = parseTime(entry.posted_at);
    if (postedAt === null || !isWithinRecentWindow(postedAt, now)) continue;

    const headline = cleanText(entry.headline);
    const summary = cleanText(entry.summary);
    if (!headline && !summary) continue;

    seen.add(id);
    posts.push({
      id,
      xUrl: entry.x_url || normalizedXUrl(id, undefined),
      headline,
      summary,
      topics: Array.isArray(entry.topics)
        ? entry.topics
            .filter((topic): topic is string => typeof topic === 'string')
            .map(cleanText)
            .filter(Boolean)
            .slice(0, 12)
        : [],
      qualityScore: finiteMetric(entry.quality_score),
      postedAt,
      canonicalUrl: entry.canonical_url,
    });
  }
  return posts;
}

async function enrichFromSyndication(
  post: TechTwitterPost,
): Promise<EnrichedTechTwitterPost> {
  const token = syndicationToken(post.id);
  const endpoint =
    `https://cdn.syndication.twimg.com/tweet-result?id=${post.id}` +
    `&lang=en&token=${token}`;
  try {
    const result = await fetchJson<SyndicationTweet>(endpoint, {
      retries: 0,
      timeoutMs: 12_000,
    });
    const text = cleanText(
      result.note_tweet?.note_tweet_results?.result?.text ??
        result.full_text ??
        result.text,
    );
    const images: string[] = [];
    if (Array.isArray(result.photos)) {
      for (const photo of result.photos) {
        addImage(images, photo.media_url_https ?? photo.url);
      }
    }
    for (const media of result.mediaDetails ?? []) {
      addImage(images, media.media_url_https ?? media.url);
    }
    addImage(images, result.video?.poster);
    return {
      text: text || undefined,
      handle: cleanHandle(result.user?.screen_name),
      displayName: cleanText(result.user?.name) || undefined,
      publishedAt: parseTime(result.created_at) ?? undefined,
      likes: finiteMetric(result.favorite_count),
      replies: finiteMetric(result.conversation_count),
      images: images.slice(0, 8),
    };
  } catch {
    return { images: [] };
  }
}

function toItem(
  post: TechTwitterPost,
  enriched: EnrichedTechTwitterPost,
): NormalizedItem | null {
  const body = enriched.text || post.summary || post.headline;
  const title = post.headline || firstSentences(body, 110);
  if (!title || !body) return null;

  const url = normalizedXUrl(post.id, enriched.handle);
  const metrics: ItemMetrics = {};
  if (enriched.likes !== undefined) metrics.likes = enriched.likes;
  if (enriched.replies !== undefined) metrics.replies = enriched.replies;
  if (post.qualityScore !== undefined) metrics.qualityScore = post.qualityScore;

  const corePost: CorePost = {
    url,
    label: title,
    handle: enriched.handle,
    likes: enriched.likes,
    replies: enriched.replies,
  };
  return {
    source: 'x',
    externalId: post.id,
    storyKey: post.id,
    title,
    body: body.slice(0, 20_000),
    brief: post.summary || firstSentences(body, 220),
    url,
    author: enriched.displayName || enriched.handle,
    authorHandle: enriched.handle,
    publishedAt: enriched.publishedAt ?? post.postedAt,
    metrics,
    images: enriched.images,
    extra: {
      provider: 'tech-twitter',
      providerLabel: 'Tech Twitter',
      providerUrl: 'https://www.techtwitter.com',
      canonicalUrl: post.canonicalUrl,
      topics: post.topics,
      qualityScore: post.qualityScore,
      corePosts: [corePost],
      timeSource: 'post',
      statsSource: enriched.text ? 'x-syndication' : 'tech-twitter',
    },
    contentHash: hashText(`${title}\n${body}\n${url}`),
  };
}

export async function fetchTechTwitterX(
  now: number,
  excludedIds: ReadonlySet<string>,
): Promise<NormalizedItem[]> {
  const payload = await fetchJson<TechTwitterPayload>(TECH_TWITTER_TRENDING_URL, {
    headers: { accept: 'application/json' },
    retries: 1,
  });
  const posts = parseTechPosts(payload, now)
    .filter((post) => !excludedIds.has(post.id))
    .slice(0, MAX_TECH_TWITTER_ITEMS);
  const enriched = await mapLimit(posts, 4, enrichFromSyndication);
  return posts
    .map((post, index) => toItem(post, enriched[index] ?? { images: [] }))
    .filter((item): item is NormalizedItem => item !== null);
}
