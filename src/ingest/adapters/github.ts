import * as cheerio from 'cheerio';
import type { NormalizedItem } from '../../shared/types';
import { firstSentences, hashText } from '../../shared/html';
import { parseMetricNumber } from '../../shared/numbers';
import { fetchText } from '../fetch';

const TRENDING_URL = 'https://github.com/trending?since=daily';
const BEIJING_OFFSET_MS = 8 * 60 * 60_000;
const TRENDING_SLOT_MINUTES = 60;

/** Midnight of the current Beijing day, as a UTC epoch timestamp. */
export function beijingDayStart(now: number): number {
  const shifted = new Date(now + BEIJING_OFFSET_MS);
  return (
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) -
    BEIJING_OFFSET_MS
  );
}

export async function fetchGithub(now = Date.now()): Promise<NormalizedItem[]> {
  const html = await fetchText(TRENDING_URL);
  const $ = cheerio.load(html);
  const dayStart = beijingDayStart(now);
  // Trending order is expressed through publishedAt: the page sorts by
  // published_at DESC, so the top repo gets the largest timestamp. Keeping
  // every repo inside the first hour of the Beijing day groups the block
  // under 今天 without shoving GitHub to the top of 最新 on every run. The
  // anchor never exceeds `now`, or normalizeItem would clamp it and lose the
  // ordering.
  const anchor = Math.min(dayStart + TRENDING_SLOT_MINUTES * 60_000, now - 60_000);
  const items: NormalizedItem[] = [];

  $('article.Box-row').each((index, article) => {
    const node = $(article);
    const href = node.find('h2 a').first().attr('href');
    if (!href) return;

    const fullName = decodeURIComponent(href.replace(/^\//, '').replace(/\/$/, ''));
    if (!fullName.includes('/')) return;

    const title =
      node.find('h2 a').first().text().replace(/\s+/g, '') || fullName;
    const description = node.find('p.col-9').first().text().trim();
    const language = node.find('span[itemprop="programmingLanguage"]').first().text().trim();
    const articleText = node.text();
    const starsToday =
      parseMetricNumber(articleText.match(/([\d,.]+\s*[kKmM万]?)\s+stars?\s+today/i)?.[1]) ?? 0;
    const starsTotal = parseMetricNumber(
      node.find('a[href$="/stargazers"]').first().text(),
    );

    const [owner] = fullName.split('/');
    const url = `https://github.com/${fullName}`;

    items.push({
      source: 'github',
      externalId: fullName,
      title: decodeURIComponent(title),
      body: description,
      brief: firstSentences(description, 170),
      url,
      author: owner,
      publishedAt: Math.max(dayStart + 1, anchor - index * 60_000),
      metrics: {
        starsToday,
        ...(starsTotal !== undefined ? { starsTotal } : {}),
      },
      images: [],
      extra: {
        lang: language || undefined,
        timeSource: 'trending',
      },
      // Star count is a fast-moving metric. Keeping it out of the content hash
      // lets D1 throttle metric writes without also postponing text edits.
      contentHash: hashText(`${fullName}\n${description}`),
    });
  });

  if (items.length === 0) throw new Error('GitHub Trending page structure changed');
  return items;
}
