/**
 * Date math for formulas works on UTC milliseconds and never reads the
 * process time zone, so results are identical in every TZ (the task runs
 * tests under Pacific/Auckland and America/Los_Angeles).
 *
 * Known simplification: "days" on a date-time adds 24h, not a calendar day in
 * the field's time zone, so a DST switch shifts the wall-clock time by an hour.
 */

export const DATE_UNITS = ["seconds", "minutes", "hours", "days", "weeks", "months", "years"] as const;
export type DateUnit = (typeof DATE_UNITS)[number];

const MS_PER_UNIT: Record<Exclude<DateUnit, "months" | "years">, number> = {
  seconds: 1000,
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
  weeks: 604_800_000,
};

/** Accepts singular and plural unit names, case-insensitively: "Day", "days". */
export function parseDateUnit(text: string): DateUnit | null {
  const normalized = text.trim().toLowerCase();
  const plural = normalized.endsWith("s") ? normalized : `${normalized}s`;
  return (DATE_UNITS as readonly string[]).includes(plural) ? (plural as DateUnit) : null;
}

function addMonths(ms: number, months: number): number {
  const date = new Date(ms);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  // Clamp to the target month's last day: Jan 31 + 1 month = Feb 28/29, not Mar 3.
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return date.getTime();
}

export function addToDate(ms: number, amount: number, unit: DateUnit): number {
  if (unit === "months") return addMonths(ms, amount);
  if (unit === "years") return addMonths(ms, amount * 12);
  return ms + amount * MS_PER_UNIT[unit];
}

/** Whole months from `to` to `from`, truncated toward zero. */
function monthsBetween(from: number, to: number): number {
  const a = new Date(from);
  const b = new Date(to);
  let months = (a.getUTCFullYear() - b.getUTCFullYear()) * 12 + (a.getUTCMonth() - b.getUTCMonth());
  // Not a full month yet if adding the months to `to` overshoots `from`.
  if (months > 0 && addMonths(to, months) > from) months--;
  if (months < 0 && addMonths(to, months) < from) months++;
  return months;
}

/** `from - to` in whole units, truncated toward zero (like Airtable's DATETIME_DIFF). */
export function dateDiff(from: number, to: number, unit: DateUnit): number {
  if (unit === "months") return monthsBetween(from, to);
  if (unit === "years") return Math.trunc(monthsBetween(from, to) / 12);
  return Math.trunc((from - to) / MS_PER_UNIT[unit]);
}

/** Today's calendar date in the given time zone, as UTC midnight milliseconds. */
export function todayIn(now: Date, timeZone = "UTC"): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(part("year"), part("month") - 1, part("day"));
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parses the storage formats (`YYYY-MM-DD` or an ISO instant). Returns null for anything else. */
export function parseStoredDate(text: string): { ms: number; hasTime: boolean } | null {
  const dateOnly = DATE_ONLY.exec(text);
  if (dateOnly) {
    const [, y, m, d] = dateOnly.map(Number);
    const ms = Date.UTC(y, m - 1, d);
    // Reject overflowing dates such as 2026-02-30 (Date.UTC would roll them into March).
    return new Date(ms).getUTCDate() === d ? { ms, hasTime: false } : null;
  }
  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) {
    const ms = Date.parse(text);
    return Number.isNaN(ms) ? null : { ms, hasTime: true };
  }
  return null;
}

export function formatStoredDate(ms: number, hasTime: boolean): string {
  const iso = new Date(ms).toISOString();
  return hasTime ? iso : iso.slice(0, 10);
}
