import type { NormalizedItem } from '../../shared/types';
import { extractImages, firstSentences, hashText, stripHtml } from '../../shared/html';
import { fetchText } from '../fetch';
import { parseRss, parseRssDate } from '../rss';

const RSS_URL = 'https://linux.do/latest.rss';
// linux.do blocks most datacenter IPs with a Cloudflare challenge. The public
// Jina Reader fetches the same RSS; requesting HTML returns the raw XML, so
// descriptions, post counts and images are preserved.
const READER_URL = 'https://r.jina.ai/https://linux.do/latest.rss';

// Discourse canonical URLs are `/t/<slug>/<id>`; the older reader emitted
// `/t/topic/<id>`, which is just one possible slug.
const TOPIC_URL = /https:\/\/linux\.do\/t\/(?:[^/\s)]+\/)?\d+/;
const TOPIC_ID = /\/t\/(?:[^/\s]+?\/)?(\d+)/;

export function parseReaderMarkdown(markdown: string): NormalizedItem[] {
  const items: NormalizedItem[] = [];
  for (const section of markdown.split(/\n### \[/).slice(1)) {
    const heading = section.match(new RegExp(`^([^\\n]+?)\\]\\((${TOPIC_URL.source})\\)`));
    if (!heading) continue;
    const title = heading[1]!.trim();
    const url = heading[2]!;
    const dateMatch = section.match(
      /([A-Z][a-z]{2}, \d{1,2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} [+-]\d{4})/,
    );
    const publishedAt = dateMatch ? Date.parse(dateMatch[1]!) : Date.now();
    items.push({
      source: 'linuxdo',
      externalId: url.match(TOPIC_ID)?.[1] ?? url,
      title,
      url,
      publishedAt: Number.isFinite(publishedAt) ? publishedAt : Date.now(),
      metrics: {},
      extra: { timeSource: 'rss', proxy: 'jina' },
      contentHash: hashText(`${title}\n${url}`),
    });
  }
  return items;
}

async function fetchViaReader(): Promise<NormalizedItem[]> {
  const body = await fetchText(READER_URL, {
    headers: {
      accept: 'application/rss+xml,application/xml,text/xml,text/plain',
      'x-return-format': 'html',
    },
    timeoutMs: 30_000,
  });
  if (body.includes('<rss')) return mapRssItems(body);
  // Older Reader responses are Markdown; keep a conservative fallback. Zero
  // items means the reader answered with a challenge or error page, which
  // must surface as a source failure instead of a silent empty success.
  const items = parseReaderMarkdown(body);
  if (items.length === 0) throw new Error('LINUX DO Reader returned no usable topics');
  return items;
}

function mapRssItems(xml: string): NormalizedItem[] {
  return parseRss(xml)
    .filter((item) => item.title && item.link)
    .map((item) => {
      const html = item.description;
      const plainText = stripHtml(html);
      const posts = Number(plainText.match(/(\d+)\s*(?:个帖子|posts?)/i)?.[1] ?? 0);
      const participants = Number(
        plainText.match(/(\d+)\s*(?:位参与者|participants?)/i)?.[1] ?? 0,
      );
      const plain = plainText
        .replace(/阅读完整话题|Read full topic/gi, '')
        // Discourse renders the footer as "3 posts - 2 participants"; anchor on
        // that exact shape so an en dash in the prose is not eaten.
        .replace(/\d+\s*(?:个帖子|posts?)\s*-\s*\d+\s*(?:位参与者|participants?)/gi, '')
        .replace(/\d+\s*(?:个帖子|posts?)/gi, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      const externalId =
        item.link.match(TOPIC_ID)?.[1] ||
        item.guid.replace(/^linux\.do-topic-/, '') ||
        item.link;

      return {
        source: 'linuxdo' as const,
        externalId,
        title: item.title,
        body: plain,
        brief: firstSentences(plain, 170),
        url: item.link,
        author: item.creator || undefined,
        publishedAt: parseRssDate(item.pubDate),
        metrics: { posts, participants },
        images: extractImages(html, item.link),
        extra: {
          category: item.categories[0],
          postsCount: posts,
          participants,
          timeSource: 'rss',
        },
        contentHash: hashText(`${item.title}\n${plain}\n${item.link}`),
      };
    });
}

export async function fetchLinuxDo(): Promise<NormalizedItem[]> {
  let xml: string;
  try {
    xml = await fetchText(RSS_URL);
  } catch {
    return fetchViaReader();
  }
  if (!xml.includes('<rss')) return fetchViaReader();
  return mapRssItems(xml);
}
