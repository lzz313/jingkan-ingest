import type { FeedItem } from './types';

/**
 * Accounts whose X posts may enter the hot view without a second source.
 * The list is deliberately AI/engineering-focused; `X_TRUSTED_HANDLES`
 * replaces it (comma or whitespace separated) when set.
 */
export const DEFAULT_X_TRUSTED_HANDLES: ReadonlySet<string> = new Set([
  '_akhaliq',
  'anthropicai',
  'dotey',
  'fchollet',
  'garrytan',
  'gemini_notebook',
  'gergelyorosz',
  'googledeepmind',
  'gregisenberg',
  'huggingface',
  'jeremyphoward',
  'karpathy',
  'kevinrose',
  'langchainai',
  'lxfater',
  'mattpocockuk',
  'omarsar0',
  'op7418',
  'openai',
  'rauchg',
  'shadcn',
  'simonw',
  'swyx',
  'theo',
  'trq212',
]);

const EXTERNAL_LINK = /https?:\/\//i;
/**
 * Joke/meme markers strong enough to matter when a post has no link and is
 * short. Ordinary commentary without a marker is left alone: the trusted
 * account gate already removes the long tail.
 */
const JOKE_MARKER =
  /(?:😂|🤣|😅|😆|🙃|😜|🤡|🌚|🐶|\bdoge\b|\/s\b|笑死|段子|玩梗|梗图|开个玩笑|难绷|绷不住|乐子|小丑|。。。|…{2,})/i;

type XPostShape = Pick<FeedItem, 'title'> & {
  body?: string | null;
  authorHandle?: string | null;
  extra?: FeedItem['extra'];
};

export function normalizeXHandle(value: string | null | undefined): string {
  return (value ?? '').trim().replace(/^@/, '').toLowerCase();
}

/** An unset or blank value keeps the curated defaults; a set value replaces them. */
export function parseXTrustedHandles(raw: string | undefined): ReadonlySet<string> {
  const handles = (raw ?? '')
    .split(/[\s,;]+/)
    .map(normalizeXHandle)
    .filter(Boolean);
  return handles.length ? new Set(handles) : DEFAULT_X_TRUSTED_HANDLES;
}

export function isXReply(item: XPostShape): boolean {
  if (item.extra?.isReply === true) return true;
  // X replies start with the mentioned handle when syndication returns the
  // full text; the headline only rarely retains it.
  return /^@[a-z0-9_]{1,20}\b/i.test(item.title.trimStart());
}

export function isPureJokeXPost(item: XPostShape): boolean {
  const text = `${item.title}\n${item.body ?? ''}`.replace(/\s+/g, ' ').trim();
  if (!text) return true;
  const canonical = typeof item.extra?.canonicalUrl === 'string' ? item.extra.canonicalUrl : '';
  const linked = EXTERNAL_LINK.test(text) || EXTERNAL_LINK.test(canonical);
  return !linked && text.length < 160 && JOKE_MARKER.test(text);
}

/**
 * X hot eligibility: either another source confirms the story, or the account
 * is on the trusted list. Replies and pure jokes stay out either way.
 */
export function xHotEligible(
  item: XPostShape,
  relatedCount: number,
  trustedHandles: ReadonlySet<string>,
): boolean {
  if (isXReply(item) || isPureJokeXPost(item)) return false;
  if (relatedCount > 0) return true;
  const handle = normalizeXHandle(item.authorHandle);
  return Boolean(handle && trustedHandles.has(handle));
}
