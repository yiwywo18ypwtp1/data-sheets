import { wallTimeAt, wallTimeToInstant, type WallTime } from "@/lib/timezone";

/**
 * Parses dates as typed or pasted: ISO ("2026-03-12", "2026-03-12 14:30",
 * "2026-03-12T14:30:00Z") and numeric locale formats ("12/03/2026", "12.03.26 2:30 PM").
 * Day/month order comes from the user's locale: "12/03/2026" is 12 March in uk-UA
 * and December 3 in en-US.
 */

export type DateOrder = "DMY" | "MDY" | "YMD";

export function dateOrder(locale: string): DateOrder {
  const types = new Intl.DateTimeFormat(locale, { timeZone: "UTC" })
    .formatToParts(new Date(Date.UTC(2026, 10, 22)))
    .map((part) => part.type)
    .filter((type) => type === "day" || type === "month" || type === "year");
  if (types[0] === "year") return "YMD";
  return types[0] === "month" ? "MDY" : "DMY";
}

export type DateTarget = {
  includeTime: boolean;
  /** Zone the typed wall-clock time is in: the field's zone, or the viewer's when the field has none. */
  timeZone: string;
  order: DateOrder;
};

export type DateResult = { ok: true; value: string } | { ok: false; error: string };

const WITH_OFFSET = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i;
const TIME = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]\.?m\.?)?$/i;
const DATE = /^(\d{1,4})[./-](\d{1,2})[./-](\d{1,4})$/;

function pad(value: number, length = 2): string {
  return String(value).padStart(length, "0");
}

function formatDate({ year, month, day }: Pick<WallTime, "year" | "month" | "day">): string {
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

function isRealDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function parseTime(text: string): Pick<WallTime, "hour" | "minute" | "second"> | null {
  const match = TIME.exec(text.trim());
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] ?? 0);
  const meridiem = match[4]?.[0].toLowerCase();
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (meridiem === "p" ? 12 : 0);
  }
  if (hour > 23 || minute > 59 || second > 59) return null;
  return { hour, minute, second };
}

function parseDatePart(text: string, order: DateOrder): Pick<WallTime, "year" | "month" | "day"> | null {
  const match = DATE.exec(text);
  if (!match) return null;
  const [a, b, c] = [match[1], match[2], match[3]];
  let year: string, month: string, day: string;
  if (a.length === 4 || order === "YMD") [year, month, day] = [a, b, c];
  else if (order === "MDY") [month, day, year] = [a, b, c];
  else [day, month, year] = [a, b, c];

  if (year.length !== 2 && year.length !== 4) return null;
  // Two-digit years are 20xx: these are business records, not birth dates.
  const fullYear = year.length === 2 ? 2000 + Number(year) : Number(year);
  if (!isRealDate(fullYear, Number(month), Number(day))) return null;
  return { year: fullYear, month: Number(month), day: Number(day) };
}

export function parseDateInput(input: string, target: DateTarget): DateResult {
  const text = input.trim();

  // An explicit offset pins the instant; the zone is only needed to find the local date.
  if (WITH_OFFSET.test(text)) {
    const ms = Date.parse(text.replace(" ", "T"));
    if (Number.isNaN(ms)) return { ok: false, error: "Invalid date" };
    return target.includeTime
      ? { ok: true, value: new Date(ms).toISOString() }
      : { ok: true, value: formatDate(wallTimeAt(ms, target.timeZone)) };
  }

  const [datePart, ...rest] = text.split(/[T ,]+(?=\d)/);
  const date = parseDatePart(datePart, target.order);
  if (!date) return { ok: false, error: `"${input}" is not a date` };

  const timeText = rest.join(" ");
  const time = timeText ? parseTime(timeText) : { hour: 0, minute: 0, second: 0 };
  if (!time) return { ok: false, error: `"${timeText}" is not a time` };

  // A date-only field keeps the calendar date as written; a pasted "12/03/2026 0:00" is fine.
  if (!target.includeTime) return { ok: true, value: formatDate(date) };

  const ms = wallTimeToInstant({ ...date, ...time }, target.timeZone);
  if (ms === null) {
    return { ok: false, error: `${formatDate(date)} ${pad(time.hour)}:${pad(time.minute)} doesn't exist in ${target.timeZone} (clocks skip it)` };
  }
  return { ok: true, value: new Date(ms).toISOString() };
}
