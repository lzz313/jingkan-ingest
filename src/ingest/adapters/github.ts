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

interface TrendingRepo {
  fullName: string;
  title: string;
  description: string;
  language: string;
  starsToday: number;
  starsTotal?: number;
}

export async function fetchGithub(now = Date.now()): Promise<NormalizedItem[]> {
  const html = await fetchText(TRENDING_URL);
  const $ = cheerio.load(html);
  const dayStart = beijingDayStart(now);
  const repos: TrendingRepo[] = [];

  $('article.Box-row').each((_index, article) => {
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

    repos.push({
      fullName,
      title: decodeURIComponent(title),
      description,
      language,
      starsToday,
      ...(starsTotal !== undefined ? { starsTotal } : {}),
    });
  });

  if (repos.length === 0) throw new Error('GitHub Trending page structure changed');

  // Trending order is expressed through publishedAt: the page sorts by
  // published_at DESC, so the top repo gets the largest timestamp. Keeping
  // every repo inside the first hour of the Beijing day groups the block
  // under 今天 without shoving GitHub to the top of 最新 on every run. The
  // anchor never reaches `now`, or normalizeItem would clamp it and lose the
  // ordering.
  const anchor = Math.min(dayStart + TRENDING_SLOT_MINUTES * 60_000, now - 1);
  // Just after Beijing midnight the whole slot collapses into a few seconds;
  // step down within it so ranks stay strictly ordered instead of all
  // clamping to `dayStart + 1`.
  const step = Math.max(
    1,
    Math.min(60_000, Math.floor((anchor - dayStart - 1) / Math.max(1, repos.length))),
  );

  return repos.map((repo, index): NormalizedItem => {
    const [owner] = repo.fullName.split('/');
    const url = `https://github.com/${repo.fullName}`;
    return {
      source: 'github',
      externalId: repo.fullName,
      title: repo.title,
      body: repo.description,
      brief: firstSentences(repo.description, 170),
      url,
      author: owner,
      publishedAt: Math.max(dayStart + 1, anchor - index * step),
      metrics: {
        starsToday: repo.starsToday,
        ...(repo.starsTotal !== undefined ? { starsTotal: repo.starsTotal } : {}),
      },
      images: [],
      extra: {
        lang: repo.language || undefined,
        timeSource: 'trending',
      },
      // Star count is a fast-moving metric. Keeping it out of the content hash
      // lets the R2 state merger throttle metric updates without also postponing text edits.
      contentHash: hashText(`${repo.fullName}\n${repo.description}`),
    };
  });
}
