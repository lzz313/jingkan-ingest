const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  middot: '·',
  copy: '©',
  reg: '®',
  trade: '™',
  times: '×',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]+);/gi, (whole, entity: string) => {
    if (entity.startsWith('#')) {
      const hex = entity[1]?.toLowerCase() === 'x';
      const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return whole;
        }
      }
      return whole;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? whole;
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
    const srcset = tag.match(/\b(?:srcset|data-srcset)=["']([^"']+)["']/i)?.[1];
    if (srcset) {
      const first = srcset.split(',')[0]?.trim().split(/\s+/)[0];
      addCandidate(out, first, baseUrl);
    }
    for (const attr of ['src', 'data-src', 'data-original', 'data-lazy-src']) {
      const value = tag.match(new RegExp(`\\b${attr}=["']([^"']+)["']`, 'i'))?.[1];
      if (value) {
        addCandidate(out, value, baseUrl);
        break;
      }
    }
    if (out.length >= limit) return out;
  }

  for (const match of html.matchAll(/!\[[^\]]*\]\(\s*([^)\s]+)(?:\s+["'][^"']*["'])?\s*\)/g)) {
    addCandidate(out, match[1], baseUrl);
    if (out.length >= limit) return out;
  }

  for (const match of html.matchAll(/https?:\/\/[^\s"'<>()]+/gi)) {
    const url = match[0].replace(/[),.;]+$/, '');
    if (IMAGE_EXTENSION.test(url)) {
      addCandidate(out, url, baseUrl);
      if (out.length >= limit) return out;
    }
  }

  return out;
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
