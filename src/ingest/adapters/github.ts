import * as cheerio from 'cheerio';
import type { NormalizedItem } from '../../shared/types';
import { firstSentences, hashText } from '../../shared/html';
import { parseMetricNumber } from '../../shared/numbers';
import { fetchText } from '../fetch';

const TRENDING_URL = 'https://github.com/trending?since=daily';

export async function fetchGithub(): Promise<NormalizedItem[]> {
  const html = await fetchText(TRENDING_URL);
  const $ = cheerio.load(html);
  const now = Date.now();
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
      publishedAt: now - index * 60_000,
      metrics: {
        starsToday,
        ...(starsTotal !== undefined ? { starsTotal } : {}),
      },
      images: [],
      extra: {
        lang: language || undefined,
        timeSource: 'trending',
      },
      contentHash: hashText(`${fullName}\n${description}\n${starsToday}`),
    });
  });

  if (items.length === 0) throw new Error('GitHub Trending page structure changed');
  return items;
}
