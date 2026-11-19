/**
 * The canonical Beijing-time schedule shared by the worker watchdog and the
 * ingest repository, so both sides agree on when a scheduled fetch is due.
 *
 * Windows are start-inclusive and end-exclusive because the cron fires every
 * ten minutes on the hour marks: `06:00–06:10` means the 06:00 tick runs and
 * the 06:10 tick does not.
 */
const WINDOWS: ReadonlyArray<readonly [number, number]> = [
  [6 * 60, 6 * 60 + 10], // 06:00–06:10
  [7 * 60, 7 * 60 + 10], // 07:00–07:10
  [8 * 60 + 30, 12 * 60], // 08:30–12:00
  [12 * 60 + 30, 12 * 60 + 40], // 12:30–12:40
  [13 * 60, 18 * 60], // 13:00–18:00
  [18 * 60 + 30, 18 * 60 + 40], // 18:30–18:40
  [19 * 60, 23 * 60 + 40], // 19:00–23:40
];

/** True when `now` falls inside an active Beijing-time ingest window. */
export function isSourceWindow(now: number = Date.now()): boolean {
  const date = new Date(now + 8 * 3600000);
  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes();
  return WINDOWS.some(([start, end]) => minutes >= start && minutes < end);
}
