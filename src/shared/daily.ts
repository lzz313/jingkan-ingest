import type { SourceId } from './types';
import { isSourceId } from './sources';

export const DAILY_PREFIX = 'seo/daily/';
export interface DailyEntry {
  id: string; source: SourceId; title: string; originalTitle?: string; summary: string; url: string; author: string | null;
  publishedAt: number; reason: string;
}
export interface DailyDigest {
  version: 1; day: string; total: number; sources: Partial<Record<SourceId, number>>; entries: DailyEntry[];
}
export interface DailyArchivePreview {
  total?: number;
  sourceCount?: number;
  entryCount?: number;
  preview?: string;
}

export function clipDailyText(text: string, maxLength: number): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  // Slice code points, not UTF-16 code units: cutting between the two halves
  // of an emoji surrogate pair produces an invalid string in metadata and XML.
  const characters = Array.from(cleaned);
  if (characters.length <= maxLength) return cleaned;
  return `${characters.slice(0, Math.max(1, maxLength - 1)).join('').trimEnd()}…`;
}

/** Compact preview stored in R2 customMetadata so archive indexes need no extra object reads. */
export function buildDailyArchiveMetadata(digest: DailyDigest): Record<string, string> {
  const headlines: string[] = [];
  let length = 0;
  for (const entry of digest.entries) {
    const title = clipDailyText(entry.title, 34);
    if (!title || headlines.includes(title)) continue;
    const addition = (headlines.length ? 3 : 0) + title.length;
    if (headlines.length >= 3 || (headlines.length > 0 && length + addition > 110)) break;
    headlines.push(title);
    length += addition;
  }
  return {
    total: String(digest.total),
    sources: String(Object.keys(digest.sources).length),
    entries: String(digest.entries.length),
    ...(headlines.length ? { preview: headlines.join(' · ') } : {}),
  };
}

export function parseDailyArchiveMetadata(metadata?: Record<string, string>): DailyArchivePreview {
  if (!metadata) return {};
  const parseCount = (value: string | undefined): number | undefined => {
    if (!value || !/^\d+$/.test(value)) return undefined;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
  };
  const preview = metadata.preview?.trim();
  return {
    total: parseCount(metadata.total),
    sourceCount: parseCount(metadata.sources),
    entryCount: parseCount(metadata.entries),
    ...(preview ? { preview } : {}),
  };
}
export function isDailyDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}
export function dailyKey(day: string): string { return `${DAILY_PREFIX}${day.slice(0, 4)}/${day}.json`; }
export function beijingDate(timestamp: number): string { return new Date(timestamp + 8 * 3600000).toISOString().slice(0, 10); }

export function isDailyDigest(value: unknown): value is DailyDigest {
  if (!value || typeof value !== 'object') return false;
  const digest = value as DailyDigest;
  if (digest.version !== 1 || typeof digest.day !== 'string' || !isDailyDate(digest.day) || !Number.isSafeInteger(digest.total) || digest.total < 1 ||
    !digest.sources || typeof digest.sources !== 'object' || Array.isArray(digest.sources) ||
    Object.entries(digest.sources).some(([source, count]) => !isSourceId(source) || !Number.isSafeInteger(count) || count! < 1) ||
    Object.values(digest.sources).reduce((sum, count) => sum + count!, 0) !== digest.total ||
    !Array.isArray(digest.entries) || digest.entries.length < 1 || digest.entries.length > 12 || digest.entries.length > digest.total) return false;
  const ids = new Set<string>();
  const perSource = new Map<string, number>();
  return digest.entries.every((entry) => {
    if (!entry || !isSourceId(entry.source) || typeof entry.id !== 'string' || !entry.id.length || entry.id.length > 256 || ids.has(entry.id) ||
      typeof entry.title !== 'string' || !entry.title.trim() || entry.title.length > 320 ||
      (entry.originalTitle !== undefined && (typeof entry.originalTitle !== 'string' || !entry.originalTitle.trim() || entry.originalTitle.length > 320)) ||
      typeof entry.summary !== 'string' || entry.summary.length > 600 ||
      typeof entry.url !== 'string' || entry.url.length > 4000 || (entry.author !== null && (typeof entry.author !== 'string' || entry.author.length > 200)) ||
      !Number.isFinite(entry.publishedAt) || entry.publishedAt < 0 || entry.publishedAt > 253402271999999 || beijingDate(entry.publishedAt) !== digest.day ||
      typeof entry.reason !== 'string' || !entry.reason.length || entry.reason.length > 200 || !digest.sources[entry.source]) return false;
    try { if (!['https:', 'http:'].includes(new URL(entry.url).protocol)) return false; } catch { return false; }
    ids.add(entry.id);
    const count = (perSource.get(entry.source) ?? 0) + 1;
    perSource.set(entry.source, count);
    return count <= 2 && count <= digest.sources[entry.source]!;
  });
}
