import type { SourceId } from './types';
import { isSourceId } from './sources';

export const DAILY_PREFIX = 'seo/daily/';
export interface DailyEntry {
  id: string; source: SourceId; title: string; summary: string; url: string; author: string | null;
  publishedAt: number; reason: string;
}
export interface DailyDigest {
  version: 1; day: string; total: number; sources: Partial<Record<SourceId, number>>; entries: DailyEntry[];
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
      typeof entry.title !== 'string' || !entry.title.trim() || entry.title.length > 320 || typeof entry.summary !== 'string' || entry.summary.length > 600 ||
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
