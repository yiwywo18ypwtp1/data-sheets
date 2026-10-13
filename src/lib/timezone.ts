/**
 * Wall-clock time ↔ UTC instant conversion for an IANA time zone, built on Intl
 * (which ships the tz database). We need just these two operations, so a
 * Temporal polyfill or a tz library would be a lot of code for little gain.
 *
 * Nothing here reads the process time zone: results are identical on every machine.
 */

export type WallTime = { year: number; month: number; day: number; hour: number; minute: number; second: number };

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Creating an Intl formatter is slow; pasting 10k dates must not create 10k of them. */
function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

export function wallTimeAt(ms: number, timeZone: string): WallTime {
  const parts = formatterFor(timeZone).formatToParts(new Date(ms));
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
}

function wallTimeAsUtc(wall: WallTime): number {
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
}

/** The zone's UTC offset at an instant, in ms (Berlin in summer: +2h). */
function offsetAt(ms: number, timeZone: string): number {
  const wholeSeconds = Math.floor(ms / 1000) * 1000;
  return wallTimeAsUtc(wallTimeAt(wholeSeconds, timeZone)) - wholeSeconds;
}

const DAY_MS = 86_400_000;

/**
 * Converts a wall-clock time in `timeZone` to a UTC instant.
 *
 * Around a DST switch a wall time can match zero instants (spring forward:
 * 2026-03-29 02:30 doesn't exist in Europe/Berlin) or two (fall back:
 * 2026-10-25 02:30 happens twice). We try the offsets in effect a day before and
 * a day after and keep the candidates that really show this wall time.
 * - none → `null`; the caller reports it rather than silently shifting the time
 * - two → the earlier one, i.e. the first time the clock shows it (Temporal's default)
 */
export function wallTimeToInstant(wall: WallTime, timeZone: string): number | null {
  const asUtc = wallTimeAsUtc(wall);
  const candidates = [...new Set([asUtc - offsetAt(asUtc - DAY_MS, timeZone), asUtc - offsetAt(asUtc + DAY_MS, timeZone)])];
  const matches = candidates
    .filter((ms) => wallTimeAsUtc(wallTimeAt(ms, timeZone)) === asUtc)
    .sort((a, b) => a - b);
  return matches[0] ?? null;
}
