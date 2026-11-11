const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

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
