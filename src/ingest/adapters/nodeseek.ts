import type { NormalizedItem } from '../../shared/types';
import { extractImages, firstSentences, hashText, stripHtml } from '../../shared/html';
import { parseNodeSeekListing, shouldSkipNodeSeekPost, type NodeSeekStats } from '../../shared/nodeseek';
import { fetchText } from '../fetch';
import { parseRss, parseRssDate } from '../rss';

const RSS_URL = 'https://rss.nodeseek.com/';
// NodeSeek blocks datacenter IPs on its own domain, but Google's public
// translate mirror renders the same server-side listing, including the view
// and comment counts that the RSS feed omits.
const LISTING_URL =
  'https://www-nodeseek-com.translate.goog/?_x_tr_sl=auto&_x_tr_tl=zh-CN&_x_tr_hl=zh-CN';
const LISTING_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function fetchListingStats(): Promise<Map<string, NodeSeekStats>> {
  try {
    const html = await fetchText(LISTING_URL, {
      headers: {
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'user-agent': LISTING_USER_AGENT,
      },
      timeoutMs: 20_000,
      retries: 0,
    });
    return parseNodeSeekListing(html);
  } catch (error) {
    console.warn(
      `nodeseek listing stats unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
    return new Map();
  }
}

export async function fetchNodeseek(): Promise<NormalizedItem[]> {
  const [xml, stats] = await Promise.all([fetchText(RSS_URL), fetchListingStats()]);
  return parseRss(xml)
    .filter((item) => item.title && item.link)
    // Trade/carpool listings, test archives, and invite-code posts are not
    // reading material: drop them before they enter state. The Worker fallback
    // and the shared spam policy apply the same rule.
    .filter((item) => !shouldSkipNodeSeekPost({ title: item.title, category: item.categories[0] }))
    .map((item) => {
      const externalId =
        item.guid || item.link.match(/post-(\d+)/)?.[1] || item.link;
      const body = stripHtml(item.description);
      const engagement = stats.get(externalId);
      return {
        source: 'nodeseek' as const,
        externalId,
        title: item.title,
        body,
        brief: firstSentences(body, 170),
        url: item.link,
        author: item.creator || undefined,
        publishedAt: parseRssDate(item.pubDate),
        metrics: engagement
          ? { views: engagement.views, comments: engagement.comments }
          : {},
        images: extractImages(item.description, item.link),
        extra: {
          category: item.categories[0],
          timeSource: 'rss',
          contextBlocked: true,
          ...(engagement ? { statsSource: 'translate-listing' } : {}),
        },
        contentHash: hashText(`${item.title}\n${body}\n${item.link}`),
      };
    });
}
