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

/** NodeSeek nodes that are marketplaces rather than reading material. */
const SKIP_NODESEEK_CATEGORIES = new Set(['trade', 'carpool']);
/** Test/archive dumps and invite-code handouts. */
const SKIP_NODESEEK_TITLE = /留档|邀请码/;
/**
 * Buy/sell titles that were filed under another node, e.g. `【收】…`,
 * `[出] …`, `+500收corona`, `剩余+340出…`.
 */
const TRADE_NODESEEK_TITLE =
  /【(?:剩余价值)?(?:收|出|售|求购|出售|转让)】|[[［](?:收|出)[\]］]|[+＋]\s*\d+(?:\.\d+)?\s*(?:收|出)|剩余[^，。！？\s]{0,12}[+＋]?\d+(?:\.\d+)?\s*出/;

/**
 * NodeSeek posts that are not reading material: trade/carpool listings,
 * test/archive dumps, and invite-code posts. Shared by the ingest adapters and
 * the Worker fallback so the same rule drops and hides them.
 */
export function shouldSkipNodeSeekPost(input: {
  title?: string | null;
  category?: string | null;
}): boolean {
  const category = (input.category ?? '').trim().toLowerCase();
  if (SKIP_NODESEEK_CATEGORIES.has(category)) return true;
  const title = (input.title ?? '').trim();
  return SKIP_NODESEEK_TITLE.test(title) || TRADE_NODESEEK_TITLE.test(title);
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
