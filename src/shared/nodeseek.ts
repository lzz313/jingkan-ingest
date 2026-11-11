import { parseMetricNumber } from './numbers';

export interface NodeSeekStats {
  views: number;
  comments: number;
}

function countFrom(text: string | undefined): number {
  if (!text) return 0;
  const value = parseMetricNumber(text.replace(/<[^>]*>/g, ' '));
  return value && value > 0 ? Math.round(value) : 0;
}

/**
 * NodeSeek's own pages sit behind a Cloudflare challenge. Its public RSS feed
 * has no engagement data, but the Google-Translate mirror of the homepage
 * renders the same server-side listing. Each `li.post-list-item` carries the
 * post id plus view and comment counts, so we match those back to RSS items.
 */
export function parseNodeSeekListing(html: string): Map<string, NodeSeekStats> {
  const stats = new Map<string, NodeSeekStats>();
  const starts = [...html.matchAll(/<li[^>]*class="[^"]*\bpost-list-item\b[^"]*"[^>]*>/gi)];
  for (const [index, match] of starts.entries()) {
    const start = match.index ?? 0;
    const end = starts[index + 1]?.index ?? html.length;
    const block = html.slice(start, end);
    const href =
      block.match(/class="[^"]*post-title[^"]*"[\s\S]{0,500}?href="([^"]*\/post-(\d+)-\d+[^"]*)"/i) ??
      block.match(/href="([^"]*\/post-(\d+)-\d+[^"]*)"/i);
    const externalId = href?.[2];
    if (!externalId) continue;

    const read = (className: string): number => {
      const at = block.search(new RegExp(`class="[^"]*${className}[^"]*"`, 'i'));
      if (at < 0) return 0;
      const slice = block.slice(at, at + 900);
      const title = slice.match(/title="([^"]*)"/i)?.[1];
      const inner = slice.match(/<span[^>]*>([\s\S]*?)<\/span>/i)?.[1];
      return countFrom(title) || countFrom(inner);
    };

    stats.set(externalId, {
      views: read('info-views'),
      comments: read('info-comments-count'),
    });
  }
  return stats;
}
