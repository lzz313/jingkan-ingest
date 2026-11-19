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

const NO_BRIEF_SENTINEL = /^[（(【[]?\s*无\s*[）)】\].。]?$/;
const META_BRIEF =
  /信息(?:量)?(?:不足|太少|有限)|(?:无法|难以|不能)(?:概括|总结|摘要)|(?:正文|原文|全文|内容)(?:为空|无内容|没有内容|缺失)|(?:没有|缺少|缺乏)(?:足够|实质)?的?(?:信息|正文|内容)/;

export function isNoBrief(text: string | null | undefined): boolean {
  const value = text?.trim();
  return Boolean(value && (NO_BRIEF_SENTINEL.test(value) || META_BRIEF.test(value)));
}

export function isChineseBrief(text: string | null | undefined): text is string {
  return Boolean(
    text?.trim() && !isNoBrief(text) &&
    /\p{Script=Han}/u.test(text) && !needsChineseTranslation(text),
  );
}

import type { FeedItem, TranslateField } from './types';
import { sourceNeedsBriefTranslation, sourceNeedsTitleTranslation } from './sources';

export function translationText(item: FeedItem, field: TranslateField): string {
  return field === 'title' ? item.title : field === 'body' ? item.body ?? '' : item.brief || item.body || item.title;
}
export function itemNeedsTranslation(item: FeedItem, field: TranslateField): boolean {
  const supported = field === 'title' ? sourceNeedsTitleTranslation(item.source)
    : field === 'brief' ? sourceNeedsBriefTranslation(item.source) : item.source === 'hn' || item.source === 'x';
  const original = translationText(item, field);
  const translated = item[field === 'title' ? 'titleZh' : field === 'brief' ? 'briefZh' : 'bodyZh'];
  return supported && needsChineseTranslation(original) && !isUsableTranslation(original, translated);
}
