import type { ItemExtra, SourceId } from './types';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonical(entry)]));
  }
  return value;
}

/** Keep the response's original extra fields; only the write comparison omits metrics. */
export function contentExtra(source: SourceId, extra: ItemExtra): string {
  const stable = { ...extra };
  if (source === 'x') {
    delete stable.viewsPerHour;
    delete stable.qualityScore;
    if (Array.isArray(stable.corePosts)) {
      stable.corePosts = stable.corePosts.map((post) => {
        const content = { ...post };
        delete content.views;
        delete content.likes;
        delete content.retweets;
        delete content.replies;
        return content;
      });
    }
  }
  return JSON.stringify(canonical(stable));
}
