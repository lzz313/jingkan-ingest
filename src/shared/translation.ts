/** English prose needs Chinese text; names and code are retained within the translation. */
export function needsChineseTranslation(text: string | null | undefined): boolean {
  const prose = (text ?? '').replace(/https?:\/\/\S+|`[^`]*`/g, ' ');
  const latin = prose.match(/[a-z]/gi)?.length ?? 0;
  const chinese = prose.match(/\p{Script=Han}/gu)?.length ?? 0;
  return (prose.match(/[a-z]{2,}/gi)?.length ?? 0) >= 2 && latin > chinese * 3;
}

export function isUsableTranslation(original: string | null | undefined, translated: string | null | undefined): boolean {
  return Boolean(translated?.trim() && (!needsChineseTranslation(original) || /\p{Script=Han}/u.test(translated)));
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
