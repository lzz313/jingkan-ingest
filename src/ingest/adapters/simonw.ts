import type { NormalizedItem } from '../../shared/types';
import { extractImages, firstSentences, hashText, stripHtml } from '../../shared/html';
import { fetchText } from '../fetch';
import { parseRss, parseRssDate } from '../rss';
import { isWithinRecentWindow } from '../time-window';

export const SIMONW_FEED_URL = 'https://simonwillison.net/atom/everything/';
const BODY_LIMIT = 2_000;
const AI_TAG_PATTERN =
  /(^|[- ])(ai|llms?|generative-ai|agentic-engineering|agents?|claude|gemini|openai|anthropic|llama|mistral|model)([- ]|$)/i;

export function isAiRelatedSimonWEntry(categories: string[]): boolean {
  return categories.some((category) => AI_TAG_PATTERN.test(category.trim()));
}

export function parseSimonWFeed(xml: string, now = Date.now()): NormalizedItem[] {
  const entries = parseRss(xml);
  if (entries.length === 0) throw new Error('Simon Willison returned an unexpected feed');

  const items: NormalizedItem[] = [];
  for (const entry of entries) {
    if (!entry.title || !entry.link || !isAiRelatedSimonWEntry(entry.categories)) continue;
    const publishedAt = parseRssDate(entry.pubDate);
    if (!isWithinRecentWindow(publishedAt, now)) continue;

    const plain = stripHtml(entry.description);
    const body = plain.slice(0, BODY_LIMIT);
    items.push({
      source: 'simonw',
      externalId: entry.guid || entry.link,
      title: entry.title,
      body,
      brief: firstSentences(body, 220),
      url: entry.link,
      author: entry.creator || 'Simon Willison',
      publishedAt,
      metrics: {},
      images: extractImages(entry.description, entry.link),
      extra: {
        category: entry.categories.find((category) =>
          AI_TAG_PATTERN.test(category.trim()),
        ),
        categories: entry.categories,
        timeSource: 'rss',
      },
      contentHash: hashText(`${entry.title}\n${body}\n${entry.link}`),
    });
  }
  return items;
}

export async function fetchSimonW(now = Date.now()): Promise<NormalizedItem[]> {
  const xml = await fetchText(SIMONW_FEED_URL, {
    headers: { accept: 'application/atom+xml,application/xml,text/xml' },
  });
  return parseSimonWFeed(xml, now);
}
