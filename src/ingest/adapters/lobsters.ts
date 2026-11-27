import type { NormalizedItem } from '../../shared/types';
import { firstSentences, hashText } from '../../shared/html';
import { fetchJson } from '../fetch';
import { parseRssDate } from '../rss';

/**
 * Lobsters exposes the front-page ranking as public JSON, including the score
 * and comment count that its RSS feed omits. One request per run covers every
 * story on the hot page; no authentication or pagination is needed.
 */
export const LOBSTERS_HOT_URL = 'https://lobste.rs/hottest.json';
const MAX_ITEMS = 30;

interface LobstersStory {
  short_id?: unknown;
  created_at?: unknown;
  title?: unknown;
  url?: unknown;
  score?: unknown;
  comment_count?: unknown;
  description_plain?: unknown;
  tags?: unknown;
  submitter_user?: unknown;
  comments_url?: unknown;
  short_id_url?: unknown;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function metric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

function isLobstersHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'lobste.rs' || host.endsWith('.lobste.rs');
}

/** Prefer the submitted article; fall back to the Lobsters discussion page. */
function storyUrl(raw: string, commentsUrl: string, shortUrl: string): string {
  const candidates = [raw, commentsUrl, shortUrl];
  for (const [index, candidate] of candidates.entries()) {
    if (!candidate) continue;
    try {
      const url = new URL(candidate);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
      // Only the submitted URL can be rejected for pointing back at Lobsters;
      // a text post is expected to fall through to its discussion page.
      if (index === 0 && isLobstersHost(url.hostname)) continue;
      return url.toString();
    } catch {
      // Try the next candidate.
    }
  }
  return '';
}

export function mapStory(raw: LobstersStory): NormalizedItem | null {
  const externalId = text(raw.short_id);
  const title = text(raw.title);
  if (!externalId || !title) return null;

  const commentsUrl = text(raw.comments_url) || `https://lobste.rs/s/${externalId}`;
  const shortUrl = text(raw.short_id_url);
  const url = storyUrl(text(raw.url), commentsUrl, shortUrl);
  if (!url) return null;

  const body = text(raw.description_plain);
  const tags = Array.isArray(raw.tags)
    ? raw.tags.map(text).filter((tag): tag is string => Boolean(tag))
    : [];
  const author = text(raw.submitter_user);
  const publishedAt = parseRssDate(text(raw.created_at));
  const points = metric(raw.score);
  const comments = metric(raw.comment_count);

  return {
    source: 'lobsters',
    externalId,
    title,
    body,
    brief: firstSentences(body, 170),
    url,
    author,
    publishedAt,
    metrics: {
      ...(points !== undefined ? { points } : {}),
      ...(comments !== undefined ? { comments } : {}),
    },
    extra: {
      ...(tags.length > 0 ? { category: tags[0], tags: tags.join(' ') } : {}),
      lobstersUrl: commentsUrl,
      timeSource: 'post',
      lang: 'en',
    },
    contentHash: hashText(`${title}\n${body}\n${url}`),
  };
}

export async function fetchLobsters(): Promise<NormalizedItem[]> {
  const payload = await fetchJson<unknown>(LOBSTERS_HOT_URL, { timeoutMs: 25_000 });
  if (!Array.isArray(payload)) throw new Error('Lobsters returned an unexpected payload');

  const seen = new Set<string>();
  const items: NormalizedItem[] = [];
  for (const raw of payload) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const item = mapStory(raw as LobstersStory);
    if (!item || seen.has(item.externalId)) continue;
    seen.add(item.externalId);
    items.push(item);
    if (items.length >= MAX_ITEMS) break;
  }
  return items;
}
