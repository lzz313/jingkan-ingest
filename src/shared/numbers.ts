/** Parse Chinese/Western abbreviated numbers such as 1.2万, 3.5k, 1,234. */
export function parseMetricNumber(input: unknown): number | undefined {
  if (typeof input === 'number' && Number.isFinite(input)) return input;
  if (typeof input !== 'string') return undefined;

  const text = input.trim().replace(/,/g, '').replace(/\s+/g, '');
  if (!text) return undefined;

  const match = text.match(/(-?\d+(?:\.\d+)?)\s*(万|w|k|m|亿)?/i);
  if (!match) return undefined;

  const base = Number(match[1]);
  if (!Number.isFinite(base)) return undefined;

  const unit = (match[2] ?? '').toLowerCase();
  const multiplier =
    unit === '万' || unit === 'w'
      ? 10_000
      : unit === 'k'
        ? 1_000
        : unit === 'm'
          ? 1_000_000
          : unit === '亿'
            ? 100_000_000
            : 1;

  return Math.round(base * multiplier);
}

export function formatCompactNumber(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '';
  if (value >= 100_000_000) return trimZero(value / 100_000_000) + '亿';
  if (value >= 10_000) return trimZero(value / 10_000) + '万';
  if (value >= 1_000) return trimZero(value / 1_000) + 'k';
  return String(value);
}

function trimZero(value: number): string {
  return value >= 100 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, '');
}

/** X snowflake IDs encode their creation time. */
export function snowflakeToMs(id: string | bigint): number | null {
  try {
    const value = typeof id === 'bigint' ? id : BigInt(id);
    if (value <= 0n) return null;
    return Number((value >> 22n) + 1288834974657n);
  } catch {
    return null;
  }
}

export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}
