import * as cheerio from 'cheerio';
import type { NormalizedItem } from '../../shared/types';
import { extractImages, firstSentences, hashText, stripHtml } from '../../shared/html';
import { fetchText } from '../fetch';
import { parseRss, parseRssDate } from '../rss';
import { isWithinRecentWindow } from '../time-window';

export const PRODUCT_HUNT_FEED_URL = 'https://www.producthunt.com/feed';

export function productHuntTagline(content: string): string {
  const $ = cheerio.load(`<div id="product-hunt-feed">${content}</div>`);
  const paragraphs = $('#product-hunt-feed p')
    .map((_index, node) => $(node).text().replace(/\s+/g, ' ').trim())
    .get();
  return (
    paragraphs.find(
      (text) =>
        Boolean(text) &&
        !/^Discussion\s*\|\s*Link$/i.test(text) &&
        !/^(?:Discussion|Link)$/i.test(text),
    ) || ''
  );
}

function externalIdOf(guid: string, link: string): string {
  return guid.match(/\/Post\/(\d+)/i)?.[1] || link.split('/').filter(Boolean).at(-1) || '';
}

export function parseProductHuntFeed(xml: string, now = Date.now()): NormalizedItem[] {
  const entries = parseRss(xml);
  if (entries.length === 0) throw new Error('Product Hunt returned an unexpected feed');

  const items: NormalizedItem[] = [];
  for (const entry of entries) {
    if (!entry.title || !entry.link) continue;
    const publishedAt = parseRssDate(entry.pubDate);
    if (!isWithinRecentWindow(publishedAt, now)) continue;

    const tagline = productHuntTagline(entry.description);
    const body = tagline || stripHtml(entry.description);
    items.push({
      source: 'producthunt',
      externalId: externalIdOf(entry.guid, entry.link),
      title: entry.title,
      body,
      brief: firstSentences(body, 220),
      url: entry.link,
      publishedAt,
      metrics: {},
      images: extractImages(entry.description, entry.link),
      extra: {
        productUrl: entry.link,
        timeSource: 'rss',
      },
      contentHash: hashText(`${entry.title}\n${body}\n${entry.link}`),
    });
  }
  return items.filter((item) => item.externalId);
}

export async function fetchProductHunt(now = Date.now()): Promise<NormalizedItem[]> {
  const xml = await fetchText(PRODUCT_HUNT_FEED_URL, {
    headers: { accept: 'application/atom+xml,application/xml,text/xml' },
  });
  return parseProductHuntFeed(xml, now);
}
