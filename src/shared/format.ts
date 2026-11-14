import { SOURCES } from './sources';
import type { SourceId } from './types';

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const AUTHOR_MAX = 20;

export function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

export function formatClock(timestamp: number): string {
  const date = new Date(timestamp);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

export function formatDateTime(timestamp: number): string {
  const date = new Date(timestamp);
  return `${pad2(date.getMonth() + 1)}/${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

export function formatDayKey(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function formatDateInputValue(timestamp: number): string {
  return formatDayKey(timestamp);
}

export function startOfLocalDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function endOfLocalDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(23, 59, 59, 999);
  return date.getTime();
}

export function timeAgo(timestamp: number, now = Date.now()): string {
  const diff = Math.max(0, now - timestamp);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diff < minute) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`;
  const date = new Date(timestamp);
  return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function dayLabel(timestamp: number, now = Date.now()): string {
  const today = startOfLocalDay(now);
  const target = startOfLocalDay(timestamp);
  const diffDays = Math.round((today - target) / 86_400_000);
  if (diffDays === 0) return '今天';
  if (diffDays === 1) return '昨天';
  const date = new Date(timestamp);
  return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${WEEKDAYS[date.getDay()]}`;
}

export function isSameLocalDay(a: number, b: number): boolean {
  return formatDayKey(a) === formatDayKey(b);
}

/**
 * Community RSS creators can carry a profile signature after the display name
 * (LINUX DO uses a full-width colon). Cards show the name only, and long names
 * are capped so one reader cannot push the whole meta row wide.
 */
export function truncateAuthor(name: string, max = AUTHOR_MAX): string {
  const text = name.trim();
  const signature = text.indexOf('：');
  const base = (signature > 0 ? text.slice(0, signature) : text).trim();
  const chars = Array.from(base);
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('');
}

/** The author line shared by the card, its SSR markup, and the daily digest. */
export function formatAuthor(
  source: SourceId,
  author?: string | null,
  handle?: string | null,
): string {
  const raw = source === 'x'
    ? `@${handle?.trim() || author?.trim() || 'unknown'}`
    : author?.trim() || SOURCES[source].name;
  return truncateAuthor(raw);
}

export interface DayGroup<T> {
  key: string;
  label: string;
  items: T[];
}

export function groupByLocalDay<T extends { publishedAt: number }>(
  items: T[],
  now = Date.now(),
): DayGroup<T>[] {
  const groups: DayGroup<T>[] = [];
  for (const item of items) {
    const key = formatDayKey(item.publishedAt);
    let group = groups[groups.length - 1];
    if (!group || group.key !== key) {
      group = { key, label: dayLabel(item.publishedAt, now), items: [] };
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups;
}
