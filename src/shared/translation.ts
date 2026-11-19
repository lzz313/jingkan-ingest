/** English prose needs Chinese text; names and code are retained within the translation. */
export function needsChineseTranslation(text: string | null | undefined): boolean {
  const prose = (text ?? '').replace(/https?:\/\/\S+|`[^`]*`/g, ' ')
    .replace(/\s+[·|]\s+(?:Hugging Face|GitHub)\s*$/i, '')
    .replace(/\b[a-z0-9]+(?:[./_-][a-z0-9]+)+\b/gi, ' ');
  const latin = prose.match(/[a-z]/gi)?.length ?? 0;
  const chinese = prose.match(/\p{Script=Han}/gu)?.length ?? 0;
  return (prose.match(/[a-z]{2,}/gi)?.length ?? 0) >= 2 && latin > chinese * 3;
}

export function isUsableTranslation(original: string | null | undefined, translated: string | null | undefined): boolean {
  return Boolean(translated?.trim() && (!needsChineseTranslation(original) || /\p{Script=Han}/u.test(translated)));
}

import type { FeedItem, TranslateField } from './types';
import { sourceNeedsBriefTranslation, sourceNeedsTitleTranslation, sourceUsesChineseSummary } from './sources';

/**
 * Models sometimes answer the brief prompt with a note about the material
 * ("因文中信息量不足，暂无法概括。") instead of a summary. That is not a key
 * point: the card must omit the row rather than show a placeholder.
 *
 * The brief prompt also asks for a bare `无` when there is nothing to
 * summarize, so a single 无 (with optional punctuation) is a no-brief signal
 * too. It is never displayed.
 */
const NO_BRIEF_SENTINEL = /^[（(【[]?\s*无\s*[）)】\].。]?$/;
const META_BRIEF =
  /信息(?:量)?(?:不足|太少|有限)|(?:无法|难以|不能)(?:概括|总结|摘要)|(?:正文|原文|全文|内容)(?:为空|无内容|没有内容|缺失)|(?:没有|缺少|缺乏)(?:足够|实质)?的?(?:信息|正文|内容)/;

export function isNoBrief(text: string | null | undefined): boolean {
  const value = text?.trim();
  return Boolean(value && (NO_BRIEF_SENTINEL.test(value) || META_BRIEF.test(value)));
}

/** The key-point row is Chinese prose; product and repository names may remain. */
export function isChineseBrief(text: string | null | undefined): text is string {
  return Boolean(
    text?.trim() && !isNoBrief(text) &&
    /\p{Script=Han}/u.test(text) && !needsChineseTranslation(text),
  );
}

export function canShowHotBrief(item: FeedItem): boolean {
  // These sources already show briefZh as their main translated description.
  return item.source !== 'github' && !sourceUsesChineseSummary(item.source);
}

function repeatsBody(brief: string, body: string | null): boolean {
  return Boolean(body?.trim().startsWith(brief.slice(0, 40)));
}

export function hasDistinctHotBrief(item: FeedItem): boolean {
  const brief = item.brief?.trim();
  return Boolean(canShowHotBrief(item) && brief && !repeatsBody(brief, item.body));
}

export function hotBriefText(item: FeedItem): string | null {
  if (!canShowHotBrief(item)) return null;
  const brief = (isChineseBrief(item.briefZh) ? item.briefZh : item.brief)?.trim();
  if (!brief || !isChineseBrief(brief) || repeatsBody(brief, item.body) || repeatsBody(brief, item.bodyZh)) return null;
  return brief;
}

export function translationText(item: FeedItem, field: TranslateField): string {
  return field === 'title' ? item.title : field === 'body' ? item.body ?? '' : item.brief || item.body || item.title;
}
export function itemNeedsTranslation(item: FeedItem, field: TranslateField, options: { includeHotBrief?: boolean } = {}): boolean {
  const supported = field === 'title' ? sourceNeedsTitleTranslation(item.source)
    : field === 'brief' ? sourceNeedsBriefTranslation(item.source) || (options.includeHotBrief && hasDistinctHotBrief(item))
      : item.source === 'hn' || item.source === 'x';
  const original = translationText(item, field);
  const translated = item[field === 'title' ? 'titleZh' : field === 'brief' ? 'briefZh' : 'bodyZh'];
  const usable = field === 'brief' ? isChineseBrief(translated) : isUsableTranslation(original, translated);
  return Boolean(supported && needsChineseTranslation(original) && !usable);
}
