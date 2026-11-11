import * as cheerio from 'cheerio';
import type { CorePost, ItemMetrics, NormalizedItem, SourceId } from '../../shared/types';
import { extractImages, firstSentences, hashText, stripHtml } from '../../shared/html';
import { parseMetricNumber, snowflakeToMs } from '../../shared/numbers';
import { fetchText } from '../fetch';

const INDEX_URL = 'https://aitimeline.news/Daily/';

interface ParsedAnchor {
  url: string;
  label: string;
  tail: string;
}

function findReportUrls(indexHtml: string): string[] {
  const $ = cheerio.load(indexHtml);
  const urls: string[] = [];
  $('a[href]').each((_, element) => {
    const href = $(element).attr('href');
    if (!href) return;
    let decoded = href;
    try {
      decoded = decodeURIComponent(href);
    } catch {
      // Keep the raw href.
    }
    if (!decoded.includes('X日报') && !decoded.includes('X AI 日报')) return;
    try {
      const absolute = new URL(href, INDEX_URL).toString();
      if (!urls.includes(absolute)) urls.push(absolute);
    } catch {
      // Ignore malformed links.
    }
  });
  return urls.slice(0, 3);
}

function parseAnchors(liHtml: string): ParsedAnchor[] {
  const anchors: Array<{ start: number; end: number; url: string; label: string }> = [];
  const anchorPattern = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of liHtml.matchAll(anchorPattern)) {
    const rawUrl = match[1] ?? '';
    let url: string;
    try {
      url = new URL(rawUrl, 'https://x.com').toString();
    } catch {
      continue;
    }
    if (!/\/status\/\d+/.test(url)) continue;
    anchors.push({
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
      url,
      label: stripHtml(match[2] ?? ''),
    });
  }

  return anchors.map((anchor, index) => {
    const nextStart = anchors[index + 1]?.start ?? liHtml.length;
    const tail = stripHtml(liHtml.slice(anchor.end, nextStart));
    return { url: anchor.url, label: anchor.label, tail };
  });
}

function metric(text: string, label: string): number | undefined {
  const match = text.match(new RegExp(`([\\d.,]+\\s*[万wWkKmM亿]?)\\s*${label}`));
  return parseMetricNumber(match?.[1]);
}

function handleFromXUrl(url: string): string | undefined {
  try {
    return new URL(url).pathname.split('/').filter(Boolean)[0];
  } catch {
    return undefined;
  }
}

type CheerioInput = Parameters<cheerio.CheerioAPI>[0];

function parseStory(
  $: cheerio.CheerioAPI,
  h3: CheerioInput,
  category: string,
  reportUrl: string,
  reportDateMs: number,
): NormalizedItem | null {
  const heading = $(h3);
  const storyKey = (heading.attr('id') || '').trim() || hashText(heading.text()).slice(0, 12);
  const title = heading.text().replace(/¶/g, '').replace(/\s+/g, ' ').trim();
  if (!title) return null;

  const nodes = heading.nextUntil('h2, h3');
  const paragraphs = nodes
    .filter('p')
    .map((_, el) => $(el).text().replace(/\s+/g, ' ').trim())
    .get()
    .filter(Boolean);

  const body = paragraphs.join('\n\n').slice(0, 20_000);
  const why = paragraphs.find((p) => p.includes('为什么值得关注'));
  const brief = why
    ? why.replace(/^.*?为什么值得关注[：:]\s*/, '').trim().slice(0, 360)
    : firstSentences(body, 180);

  const corePosts: CorePost[] = [];
  nodes.find('li').each((_, li) => {
    const label = $(li).find('.fk-label').first().text().trim();
    if (label !== '核心原帖') return;
    const html = $.html(li);
    for (const anchor of parseAnchors(html)) {
      if (corePosts.some((post) => post.url === anchor.url)) continue;
      corePosts.push({
        url: anchor.url,
        label: anchor.label,
        handle: handleFromXUrl(anchor.url),
        views: metric(anchor.tail, '浏览'),
        likes: metric(anchor.tail, '赞'),
        retweets: metric(anchor.tail, '转发'),
        replies: metric(anchor.tail, '回复'),
      });
    }
  });

  const postTimes = corePosts
    .map((post) => snowflakeToMs(post.url.match(/\/status\/(\d+)/)?.[1] ?? ''))
    .filter((value): value is number => value !== null && Number.isFinite(value));
  const publishedAt = postTimes.length > 0 ? Math.min(...postTimes) : reportDateMs;

  const metrics: ItemMetrics = {};
  for (const key of ['views', 'likes', 'retweets', 'replies'] as const) {
    const values = corePosts
      .map((post) => post[key])
      .filter((value): value is number => typeof value === 'number');
    if (values.length > 0) metrics[key] = Math.max(...values);
  }

  const relatedUrls: string[] = [];
  nodes.find('a[href]').each((_, element) => {
    const href = $(element).attr('href');
    if (!href || !/^https?:\/\//i.test(href)) return;
    if (/^https?:\/\/(www\.)?(x|twitter)\.com\//i.test(href)) return;
    if (href.includes('aitimeline.news')) return;
    if (!relatedUrls.includes(href)) relatedUrls.push(href);
  });

  const imageHtml = nodes
    .find('img')
    .map((_, element) => $.html(element))
    .get()
    .join('');

  // Some reports use h3 as a digest bucket ("其他研究与模型发布") with no
  // verifiable core post. It has no author, metrics or source timestamp and
  // would surface as a fresh item every run, so keep only actual stories.
  if (corePosts.length === 0) return null;

  const firstPost = corePosts[0];

  return {
    source: 'x' as SourceId,
    externalId: storyKey,
    storyKey,
    title,
    titleZh: title,
    body,
    brief,
    url: firstPost?.url ?? `${reportUrl}#${storyKey}`,
    author: firstPost?.handle,
    authorHandle: firstPost?.handle,
    publishedAt,
    metrics,
    images: extractImages(imageHtml, reportUrl),
    extra: {
      category: category || undefined,
      corePosts,
      relatedUrls: relatedUrls.slice(0, 4),
      timeSource: postTimes.length > 0 ? 'post' : 'digest',
    },
    contentHash: hashText(`${title}\n${body}\n${reportUrl}`),
  };
}

export async function fetchX(): Promise<NormalizedItem[]> {
  const indexHtml = await fetchText(INDEX_URL);
  const reportUrls = findReportUrls(indexHtml);
  if (reportUrls.length === 0) throw new Error('No X daily report link found');

  let reportUrl = reportUrls[0]!;
  let reportHtml = '';
  let lastError: unknown;
  for (const candidate of reportUrls) {
    try {
      reportHtml = await fetchText(candidate);
      reportUrl = candidate;
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!reportHtml) {
    throw lastError instanceof Error ? lastError : new Error('Could not fetch X daily report');
  }

  const dateMatch = reportUrl.match(/(\d{4})-(\d{2})-(\d{2})/);
  const reportDateMs = dateMatch
    ? Date.UTC(Number(dateMatch[1]), Number(dateMatch[2]) - 1, Number(dateMatch[3]), 12)
    : Date.now();

  const $ = cheerio.load(reportHtml);
  const stories: NormalizedItem[] = [];
  $('h3').each((_, h3) => {
    const category = $(h3)
      .prevAll('h2')
      .first()
      .text()
      .replace(/¶/g, '')
      .replace(/^\d+\.\s*/, '')
      .trim();
    const story = parseStory($, h3, category, reportUrl, reportDateMs);
    if (story) stories.push(story);
  });

  if (stories.length === 0) throw new Error('X daily report contained no stories');
  return stories;
}
