import { deduplicateImages } from './images';
import { decodeEntities } from './entities';
export { decodeEntities } from './entities';

/** Escape text for HTML text nodes and quoted attribute values. */
export function escapeHtml(value: string | null | undefined): string {
  return (value ?? '').replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

/** Convert source HTML to readable plain text. Never inject this as HTML. */
export function stripHtml(html: string | null | undefined): string {
  if (!html) return '';
  const text = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|blockquote|h[1-6]|tr|section|article)>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '• ')
    .replace(/<img\b[^>]*alt=["']([^"']*)["'][^>]*>/gi, ' $1 ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return decodeEntities(text);
}

/**
 * Strip Markdown constructs that would leak into plain-text summaries (SSR
 * cards, meta descriptions). Full Markdown is rendered by the client; this is
 * deliberately conservative so prose like `3 * 4 * 5` and `snake_case` stays
 * untouched.
 */
export function stripMarkdown(markdown: string | null | undefined): string {
  if (!markdown) return '';
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)\s]*(?:\s+"[^"]*")?\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)\s]*(?:\s+"[^"]*")?\)/g, '$1')
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]{0,3}>[ \t]?/gm, '')
    .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gm, '')
    .replace(/\*\*([^\s*][^*\n]*?)\*\*/g, '$1')
    .replace(/(?<!\*)\*([^\s*][^*\n]*?)\*(?!\*)/g, '$1')
    .replace(/~~([^\s~][^~\n]*?)~~/g, '$1')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const IMAGE_EXTENSION = /\.(?:png|jpe?g|gif|webp|avif|bmp)(?:[?#].*)?$/i;

function addCandidate(out: string[], value: string | undefined, baseUrl?: string) {
  if (!value) return;
  let cleaned = value.trim().replace(/^['"]|['"]$/g, '');
  if (!cleaned || cleaned.startsWith('data:') || cleaned.startsWith('javascript:')) return;
  if (cleaned.startsWith('//')) cleaned = 'https:' + cleaned;
  try {
    const url = new URL(cleaned, baseUrl || undefined);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    if (/(?:^|[/._-])avatars?(?:[/._-]|$)/i.test(url.pathname)) return;
    if (/(?:^|[/._-])(?:emoji|smiley|smilies)(?:[/._-]|$)/i.test(url.pathname)) return;
    cleaned = url.toString();
  } catch {
    if (!/^https?:\/\//i.test(cleaned)) return;
  }
  if (!out.includes(cleaned)) out.push(cleaned);
}

/**
 * Extract display-worthy images from HTML or Markdown. Relative URLs are
 * resolved against baseUrl. Results are deduplicated and capped at 8.
 */
export function extractImages(html: string | null | undefined, baseUrl?: string, limit = 8): string[] {
  if (!html) return [];
  const out: string[] = [];

  for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = match[0];
    // One img element represents one picture; srcset lists alternate sizes.
    let candidate: string | undefined;
    for (const attr of ['data-original', 'data-src', 'data-lazy-src', 'src']) {
      const value = tag.match(new RegExp(`(?:^|\\s)${attr}=["']([^"']+)["']`, 'i'))?.[1];
      if (value) { candidate = value; break; }
    }
    if (!candidate) {
      const srcset = tag.match(/(?:^|\s)(?:srcset|data-srcset)=["']([^"']+)["']/i)?.[1];
      candidate = srcset?.split(',').at(-1)?.trim().split(/\s+/)[0];
    }
    addCandidate(out, candidate, baseUrl);
  }

  for (const match of html.matchAll(/!\[[^\]]*\]\(\s*([^)\s]+)(?:\s+["'][^"']*["'])?\s*\)/g)) {
    addCandidate(out, match[1], baseUrl);
  }

  const withoutImageTags = html.replace(/<img\b[^>]*>/gi, ' ');
  for (const match of withoutImageTags.matchAll(/https?:\/\/[^\s"'<>()]+/gi)) {
    const url = match[0].replace(/[),.;]+$/, '');
    if (IMAGE_EXTENSION.test(url)) {
      addCandidate(out, url, baseUrl);
    }
  }

  return deduplicateImages(out, baseUrl, limit);
}

export function firstSentences(text: string | null | undefined, maxLength = 180): string {
  const cleaned = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  if (cleaned.length <= maxLength) return cleaned;

  const slice = cleaned.slice(0, maxLength);
  const punctuation = Math.max(
    slice.lastIndexOf('。'),
    slice.lastIndexOf('！'),
    slice.lastIndexOf('？'),
    slice.lastIndexOf('. '),
    slice.lastIndexOf('; '),
  );
  if (punctuation > maxLength * 0.45) {
    return slice.slice(0, punctuation + 1).trim();
  }
  return slice.trimEnd() + '…';
}

export function hashText(text: string): string {
  // FNV-1a, stable across Worker and Node. Only used to detect content changes.
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function absoluteUrl(value: string, baseUrl?: string): string | null {
  try {
    const url = new URL(value, baseUrl || undefined);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}
