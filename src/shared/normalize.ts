import { deduplicateImages } from './images';
import type { ItemExtra, ItemMetrics, NormalizedItem, SourceId } from './types';
import { isSourceId } from './sources';
import { extractImages, firstSentences, hashText, stripHtml } from './html';
import { shouldHideItem } from './spam';

const MAX_TITLE = 320;
const MAX_BODY = 30_000;
const MAX_BRIEF = 400;
const MAX_BODY_ZH = 8_000;

export function normalizeItem(raw: NormalizedItem, now = Date.now()): NormalizedItem {
  if (!isSourceId(raw.source)) throw new Error(`Unknown source: ${raw.source}`);
  const externalId = String(raw.externalId ?? '').trim();
  if (!externalId) throw new Error('Missing externalId');

  const title = stripHtml(String(raw.title ?? '')).trim().slice(0, MAX_TITLE);
  if (!title) throw new Error(`Missing title for ${raw.source}:${externalId}`);

  let url: string;
  try {
    url = new URL(String(raw.url)).toString();
    if (!url.startsWith('http://') && !url.startsWith('https://')) throw new Error('bad protocol');
  } catch {
    throw new Error(`Invalid url for ${raw.source}:${externalId}`);
  }

  const body = stripHtml(raw.body ?? '').slice(0, MAX_BODY);
  const brief = (raw.brief || firstSentences(body, 180)).trim().slice(0, MAX_BRIEF);
  const images = deduplicateImages([...(raw.images ?? []), ...extractImages(raw.body, url)], url);

  const metrics: ItemMetrics = {};
  for (const [key, value] of Object.entries(raw.metrics ?? {})) {
    if (typeof value === 'number' && Number.isFinite(value)) metrics[key] = value;
    else if (typeof value === 'string') metrics[key] = value;
  }

  const extra: ItemExtra = { ...(raw.extra ?? {}) };
  if (extra.relatedUrls) {
    extra.relatedUrls = Array.from(new Set(extra.relatedUrls.filter((u) => /^https?:\/\//.test(u)))).slice(0, 4);
  }

  const item: NormalizedItem = {
    source: raw.source as SourceId,
    externalId,
    storyKey: raw.storyKey ? String(raw.storyKey).slice(0, 200) : undefined,
    title,
    titleZh: raw.titleZh ? String(raw.titleZh).slice(0, MAX_TITLE) : undefined,
    body,
    brief,
    briefZh: raw.briefZh ? String(raw.briefZh).slice(0, MAX_BRIEF) : undefined,
    bodyZh: raw.bodyZh ? String(raw.bodyZh).slice(0, MAX_BODY_ZH) : undefined,
    url,
    author: raw.author ? String(raw.author).slice(0, 120) : undefined,
    authorHandle: raw.authorHandle ? String(raw.authorHandle).slice(0, 120) : undefined,
    publishedAt:
      Number.isFinite(raw.publishedAt) && raw.publishedAt > 0
        ? Math.min(Number(raw.publishedAt), now + 5 * 60_000)
        : now,
    metrics,
    images,
    extra,
    hidden: Boolean(raw.hidden || shouldHideItem({ source: raw.source as SourceId, title, body, url, extra })),
    contentHash: raw.contentHash ?? hashText(`${title}\n${body}\n${url}`),
  };

  return item;
}
