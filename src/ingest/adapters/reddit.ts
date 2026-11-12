import { XMLParser } from 'fast-xml-parser';
import type { NormalizedItem } from '../../shared/types';
import { decodeEntities, extractImages, firstSentences, hashText, stripHtml } from '../../shared/html';
import { fetchText } from '../fetch';
import { parseRssDate } from '../rss';

/**
 * Reddit blocks its JSON API for datacenter IPs (403), but the Atom feeds are
 * still served. The multireddit hot feed returns 25 posts in Reddit's own hot
 * order, which is the only engagement signal available there: the feed has no
 * scores or comment counts. Fetch it exactly once per run — Reddit rate-limits
 * RSS aggressively (429 after a couple of rapid requests from one IP).
 */
export const REDDIT_FEED_URL =
  'https://www.reddit.com/r/programming+technology+LocalLLaMA+webdev/hot/.rss';

type XmlNode = unknown;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  trimValues: true,
  processEntities: true,
});

function textOf(value: XmlNode): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    for (const entry of value) {
      const text = textOf(entry);
      if (text) return text;
    }
    return '';
  }
  if (typeof value === 'object') {
    const record = value as Record<string, XmlNode>;
    const text = record['#text'];
    if (typeof text === 'string') return text.trim();
    if (typeof text === 'number') return String(text);
  }
  return '';
}

function attribute(value: XmlNode, name: string): string {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const found = (value as Record<string, XmlNode>)[`@_${name}`];
    if (typeof found === 'string') return found.trim();
  }
  return '';
}

function linkHref(value: XmlNode): string {
  const nodes = Array.isArray(value) ? value : [value];
  for (const node of nodes) {
    const href = attribute(node, 'href');
    if (href) return href;
    const text = textOf(node);
    if (text) return text;
  }
  return '';
}

function authorOf(value: XmlNode): string {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const name = textOf((value as Record<string, XmlNode>).name);
    if (name) return name;
  }
  return textOf(value);
}

function isRedditHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === 'reddit.com' ||
    host.endsWith('.reddit.com') ||
    host === 'redd.it' ||
    host.endsWith('.redd.it')
  );
}

/** The post's own text sits between the SC_OFF / SC_ON comments. */
function selfText(html: string): string {
  const match = html.match(/<!--\s*SC_OFF\s*-->([\s\S]*?)<!--\s*SC_ON\s*-->/i);
  return match ? stripHtml(match[1] ?? '').trim() : '';
}

/** Link posts carry the target inside a `[link]` anchor; self posts do not. */
function externalUrl(html: string, permalink: string): string {
  for (const match of html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>\s*\[link\]\s*<\/a>/gi)) {
    try {
      const url = new URL(decodeEntities(match[1] ?? ''));
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
      if (isRedditHost(url.hostname)) continue;
      return url.toString();
    } catch {
      // Ignore malformed links.
    }
  }
  return permalink;
}

function mapEntry(raw: XmlNode, index: number): NormalizedItem | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entry = raw as Record<string, XmlNode>;

  const id = textOf(entry.id);
  const externalId = id.startsWith('t3_') ? id.slice(3) : '';
  if (!externalId) return null;

  const title = stripHtml(textOf(entry.title));
  if (!title) return null;

  const permalink = linkHref(entry.link);
  if (!/^https?:\/\//i.test(permalink)) return null;

  const content = textOf(entry.content);
  const body = selfText(content);
  const url = externalUrl(content, permalink);

  const category = Array.isArray(entry.category) ? entry.category[0] : entry.category;
  const subreddit =
    attribute(category, 'term') || attribute(category, 'label').replace(/^r\//i, '');

  const thumbnail = decodeEntities(attribute(entry.thumbnail, 'url'));
  const images = extractImages(content, permalink).map((value) => decodeEntities(value));
  if (thumbnail) images.unshift(thumbnail);

  const publishedAt = parseRssDate(textOf(entry.published) || textOf(entry.updated));

  return {
    source: 'reddit',
    externalId,
    title,
    body,
    brief: firstSentences(body, 170),
    url,
    author: authorOf(entry.author).replace(/^\/u\//i, ''),
    publishedAt,
    // Reddit's RSS exposes no vote or comment counts; its hot order is the
    // engagement signal, consumed by computeHot() as `rank`.
    metrics: { rank: index + 1 },
    images,
    extra: {
      ...(subreddit ? { subreddit } : {}),
      redditUrl: permalink,
      timeSource: 'post',
    },
    contentHash: hashText(`${title}\n${body}\n${url}`),
  };
}

export async function fetchReddit(): Promise<NormalizedItem[]> {
  // One request per run: retrying a 429 immediately only burns the quota.
  // Keep the default `*/*` Accept header: the probes that succeeded used it,
  // while the only failed run (westus2) sent an Atom-specific one.
  const xml = await fetchText(REDDIT_FEED_URL, { retries: 0, timeoutMs: 25_000 });

  const parsed = parser.parse(xml) as Record<string, unknown>;
  const feed = parsed.feed as Record<string, unknown> | undefined;
  if (!feed) throw new Error('Reddit returned an unexpected feed');

  const rawEntries = feed.entry;
  const entries = Array.isArray(rawEntries) ? rawEntries : rawEntries ? [rawEntries] : [];
  const seen = new Set<string>();
  const items: NormalizedItem[] = [];
  for (const [index, entry] of entries.entries()) {
    const item = mapEntry(entry, index);
    if (!item || seen.has(item.externalId)) continue;
    seen.add(item.externalId);
    items.push(item);
  }
  return items;
}
