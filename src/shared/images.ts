import { decodeEntities } from './entities';

const LINUXDO_IMAGE_HOST = /(?:^|\.)(?:linux\.do|ldstatic\.com)$/i;
const UPLOAD_PATH = /^\/(original|optimized)\/\d+X\/(?:[a-f0-9]\/){0,3}([a-f0-9]{40})(?:_[^/]*)?\.(?:png|jpe?g|gif|webp|avif|bmp)$/i;

function imageInfo(value: string, baseUrl?: string): { url: string; identity: string; quality: number } | null {
  try {
    const cleaned = decodeEntities(value).trim().replace(/^['"]|['"]$/g, '');
    const url = new URL(cleaned.startsWith('//') ? `https:${cleaned}` : cleaned, baseUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    const upload = LINUXDO_IMAGE_HOST.test(url.hostname) ? url.pathname.match(UPLOAD_PATH) : null;
    if (!upload) return { url: url.toString(), identity: url.toString(), quality: 0 };
    const dimensions = [...url.pathname.matchAll(/_(\d+)x(\d+)/g)].at(-1);
    return {
      url: url.toString(),
      identity: `linuxdo:${upload[2]!.toLowerCase()}`,
      quality: upload[1]!.toLowerCase() === 'original' ? Infinity : Number(dimensions?.[1] ?? 0) * Number(dimensions?.[2] ?? 0),
    };
  } catch { return null; }
}

/** Keep distinct uploads in order, using the original or largest available variant. */
export function deduplicateImages(images: readonly string[], baseUrl?: string, limit = 8): string[] {
  const unique = new Map<string, { url: string; quality: number }>();
  for (const value of images) {
    if (typeof value !== 'string') continue;
    const candidate = imageInfo(value, baseUrl);
    if (!candidate) continue;
    const previous = unique.get(candidate.identity);
    if (!previous || candidate.quality > previous.quality) unique.set(candidate.identity, candidate);
  }
  return [...unique.values()].slice(0, Math.max(0, limit)).map((image) => image.url);
}
