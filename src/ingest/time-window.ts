export const NEW_SOURCE_BACKFILL_MS = 48 * 60 * 60_000;
export const FUTURE_TOLERANCE_MS = 5 * 60_000;

export function isWithinRecentWindow(
  publishedAt: number,
  now: number,
  windowMs = NEW_SOURCE_BACKFILL_MS,
): boolean {
  return (
    Number.isFinite(publishedAt) &&
    publishedAt >= now - windowMs &&
    publishedAt <= now + FUTURE_TOLERANCE_MS
  );
}
