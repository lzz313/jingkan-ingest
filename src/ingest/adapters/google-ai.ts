import type { NormalizedItem } from '../../shared/types';
import { extractImages, firstSentences, hashText, stripHtml } from '../../shared/html';
import { fetchText } from '../fetch';
import { parseRss, parseRssDate } from '../rss';
import { isWithinRecentWindow } from '../time-window';

export const GOOGLE_AI_FEED_URL =
  'https://blog.google/innovation-and-ai/technology/ai/rss/';
const BODY_LIMIT = 2_000;

export function parseGoogleAiFeed(xml: string, now = Date.now()): NormalizedItem[] {
  // fast-xml-parser merges media:description into `description` after namespace
  // removal. Strip that image-alt field before parsing so it never becomes the
  // article summary shown on a card.
  const articleXml = xml.replace(
    /<media:description\b[^>]*>[\s\S]*?<\/media:description>/gi,
    '',
  );
  const entries = parseRss(articleXml);
  if (entries.length === 0) throw new Error('Google AI returned an unexpected feed');

  const items: NormalizedItem[] = [];
  for (const entry of entries) {
    if (!entry.title || !entry.link) continue;
    const publishedAt = parseRssDate(entry.pubDate);
    if (!isWithinRecentWindow(publishedAt, now)) continue;

    const plain = stripHtml(entry.description);
    if (!plain) continue;
    const body = plain.slice(0, BODY_LIMIT);
    const category = entry.categories.find((value) => value.toLowerCase() !== 'ai');
    items.push({
      source: 'google-ai',
      externalId: entry.guid || entry.link,
      title: entry.title,
      body,
      brief: firstSentences(body, 220),
      url: entry.link,
      author: entry.creator || undefined,
      publishedAt,
      metrics: {},
      images: extractImages(entry.description, entry.link),
      extra: {
        ...(category ? { category } : {}),
        categories: entry.categories,
        timeSource: 'rss',
      },
      contentHash: hashText(`${entry.title}\n${body}\n${entry.link}`),
    });
  }
  return items;
}

export async function fetchGoogleAi(now = Date.now()): Promise<NormalizedItem[]> {
  const xml = await fetchText(GOOGLE_AI_FEED_URL, {
    headers: { accept: 'application/rss+xml,application/xml,text/xml' },
  });
  return parseGoogleAiFeed(xml, now);
}
