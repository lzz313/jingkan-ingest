import type { SourceId } from './types';
import { isSourceId } from './sources';

export const DAILY_PREFIX = 'seo/daily/';
export const WEEKLY_PREFIX = 'seo/weekly/';
export interface DailyEntry {
  id: string; source: SourceId; title: string; originalTitle?: string; summary: string; url: string; author: string | null;
  publishedAt: number; reason: string;
}
export interface DailyDigest {
  version: 1; day: string; total: number; sources: Partial<Record<SourceId, number>>; entries: DailyEntry[];
  /** Optional AI-generated Chinese editorial overview (120–260 chars). */
  overview?: string;
}
export interface WeeklyOverview {
  version: 1;
  week: string;
  entrySignature: string;
  overview: string;
  generatedAt: number;
}
export interface DailyArchivePreview {
  total?: number;
  sourceCount?: number;
  entryCount?: number;
  preview?: string;
  sig?: string;
  hasOverview?: boolean;
}

export function clipDailyText(text: string, maxLength: number): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  // Slice code points, not UTF-16 code units: cutting between the two halves
  // of an emoji surrogate pair produces an invalid string in metadata and XML.
  const characters = Array.from(cleaned);
  if (characters.length <= maxLength) return cleaned;
  return `${characters.slice(0, Math.max(1, maxLength - 1)).join('').trimEnd()}…`;
}

/** Deterministic lightweight signature of a digest's selected entries (for AI overview caching). */
export function entriesSignature(entries: ReadonlyArray<Pick<DailyEntry, 'id' | 'title'>>): string {
  const input = entries.map((entry) => `${entry.id}:${entry.title}`).join('|');
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b1;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 16777619) >>> 0;
    h2 = Math.imul(h2 ^ (code + i), 2246822519) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
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
    sig: entriesSignature(digest.entries),
    ...(digest.overview ? { hasOverview: '1' } : {}),
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
  const sig = metadata.sig?.trim();
  return {
    total: parseCount(metadata.total),
    sourceCount: parseCount(metadata.sources),
    entryCount: parseCount(metadata.entries),
    ...(preview ? { preview } : {}),
    ...(sig && /^[a-f0-9]{8,64}$/.test(sig) ? { sig } : {}),
    ...(metadata.hasOverview === '1' ? { hasOverview: true } : {}),
  };
}
export function isDailyDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}
export function dailyKey(day: string): string { return `${DAILY_PREFIX}${day.slice(0, 4)}/${day}.json`; }
export function weeklyKey(week: string): string { return `${WEEKLY_PREFIX}${week.slice(0, 4)}/${week}.json`; }
export function beijingDate(timestamp: number): string { return new Date(timestamp + 8 * 3600000).toISOString().slice(0, 10); }

const DAY_MS = 86_400_000;

/**
 * ISO 8601 week identifier (`YYYY-Www`, Monday–Sunday) for a YYYY-MM-DD calendar date.
 */
export function isoWeekOfDay(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  // Shift to Thursday of the same ISO week: that Thursday's calendar year is
  // the ISO week-year, and its day-of-year determines the week number.
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const isoYear = date.getUTCFullYear();
  const yearStart = Date.UTC(isoYear, 0, 1);
  const week = Math.floor((date.getTime() - yearStart) / DAY_MS / 7) + 1;
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

export interface IsoWeekBounds {
  week: string;
  year: number;
  weekNumber: number;
  start: string;
  end: string;
  days: string[];
  years: string[];
}

/**
 * Resolve an ISO week id (`YYYY-Www`) into its Monday–Sunday calendar dates,
 * or null when the format or week number is out of range for that ISO year.
 */
export function isoWeekBounds(value: string): IsoWeekBounds | null {
  const match = value.match(/^(\d{4})-W(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const weekNumber = Number(match[2]);
  if (weekNumber < 1 || weekNumber > 53) return null;
  // Jan 4 is always in ISO week 1. Walk back to its Monday, then advance.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Weekday = jan4.getUTCDay() || 7;
  const week1Monday = Date.UTC(year, 0, 4 - (jan4Weekday - 1));
  const mondayMs = week1Monday + (weekNumber - 1) * 7 * DAY_MS;
  const start = new Date(mondayMs).toISOString().slice(0, 10);
  // Verify round-trip so week 53 is rejected for 52-week years.
  if (isoWeekOfDay(start) !== value) return null;
  const days = Array.from({ length: 7 }, (_, index) =>
    new Date(mondayMs + index * DAY_MS).toISOString().slice(0, 10),
  );
  const end = days[6]!;
  const years = [...new Set([start.slice(0, 4), end.slice(0, 4)])];
  return { week: value, year, weekNumber, start, end, days, years };
}

export function isIsoWeek(value: string): boolean {
  return isoWeekBounds(value) !== null;
}

export function formatIsoWeekLabel(week: string): string {
  const match = week.match(/^(\d{4})-W(\d{2})$/);
  if (!match) return week;
  return `${match[1]} 年第 ${Number(match[2])} 周`;
}

export function isDailyDigest(value: unknown): value is DailyDigest {
  if (!value || typeof value !== 'object') return false;
  const digest = value as DailyDigest;
  if (digest.version !== 1 || typeof digest.day !== 'string' || !isDailyDate(digest.day) || !Number.isSafeInteger(digest.total) || digest.total < 1 ||
    (digest.overview !== undefined && (typeof digest.overview !== 'string' || !digest.overview.trim() || digest.overview.length > 600)) ||
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

export function isWeeklyOverview(value: unknown): value is WeeklyOverview {
  if (!value || typeof value !== 'object') return false;
  const record = value as WeeklyOverview;
  return (
    record.version === 1 &&
    typeof record.week === 'string' &&
    isIsoWeek(record.week) &&
    typeof record.entrySignature === 'string' &&
    /^[a-f0-9]{8,64}$/.test(record.entrySignature) &&
    typeof record.overview === 'string' &&
    record.overview.trim().length > 0 &&
    record.overview.length <= 600 &&
    typeof record.generatedAt === 'number' &&
    Number.isFinite(record.generatedAt) &&
    record.generatedAt > 0
  );
}
