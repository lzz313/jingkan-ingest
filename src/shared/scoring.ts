import type { ItemMetrics, NormalizedItem } from './types';

export interface HotResult {
  isHot: boolean;
  score: number;
}

function finite(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function scaled(value: number, threshold: number, floor = 40, span = 60): number {
  if (threshold <= 0) return 0;
  const ratio = Math.max(1, value / threshold);
  // Keep headroom above the threshold: a 256× threshold value reaches 100,
  // so ordinary hot items do not all collapse into identical perfect scores.
  return Math.min(100, floor + Math.log2(ratio) * (span / 8));
}

/**
 * Per-source hot thresholds keep GitHub's star counts from drowning out
 * V2EX replies. Scores are normalized to roughly 40–100.
 */
export function computeHot(source: NormalizedItem['source'], metrics: ItemMetrics): HotResult {
  switch (source) {
    case 'x': {
      const views = finite(metrics.views);
      const likes = finite(metrics.likes);
      const isHot = views >= 100_000 || likes >= 1_000;
      return {
        isHot,
        score: isHot ? scaled(Math.max(views, likes * 100), 100_000) : 0,
      };
    }
    case 'v2ex': {
      const replies = finite(metrics.replies);
      const isHot = replies >= 20;
      // Score even below the hot threshold so the balanced hot view can rank
      // the most-discussed topics instead of falling back to pure recency.
      return { isHot, score: replies > 0 ? scaled(replies, 1, 10, 60) : 0 };
    }
    case 'linuxdo': {
      const posts = finite(metrics.posts ?? metrics.replies);
      const isHot = posts >= 10;
      return { isHot, score: posts > 0 ? scaled(posts, 1, 10, 60) : 0 };
    }
    case 'hn': {
      const points = finite(metrics.points);
      const comments = finite(metrics.comments);
      const isHot = points >= 30 || comments >= 20;
      return { isHot, score: isHot ? scaled(points + comments * 2, 50, 40, 60) : 0 };
    }
    case 'github': {
      const stars = finite(metrics.starsToday);
      const isHot = stars >= 100;
      return { isHot, score: isHot ? scaled(stars, 100, 40, 60) : 0 };
    }
    case 'nodeseek': {
      const comments = finite(metrics.comments ?? metrics.replies);
      const isHot = comments >= 10;
      return { isHot, score: comments > 0 ? scaled(comments, 1, 10, 60) : 0 };
    }
    default:
      return { isHot: false, score: 0 };
  }
}

export function applyHot<T extends Pick<NormalizedItem, 'source' | 'metrics'>>(
  item: T,
): T & { hotScore: number; isHot: boolean } {
  const result = computeHot(item.source, item.metrics ?? {});
  return { ...item, hotScore: Math.round(result.score * 10) / 10, isHot: result.isHot };
}
