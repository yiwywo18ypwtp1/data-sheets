import type { CellValue } from "@/lib/domain/cell";
import type { Field } from "@/lib/domain/field";
import { roundTo } from "@/lib/coerce/numbers";

/**
 * What the fill handle writes below a selection, per column, like a spreadsheet:
 * one value is copied; two or more numbers or dates with a constant step continue the
 * progression (1, 2 → 3, 4; Mon, Wed → Fri); anything else repeats the pattern.
 */

const DAY_MS = 86_400_000;
const isDateOnly = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);

/** The constant difference between consecutive values, or null if there isn't one. */
function constantStep(values: number[]): number | null {
  if (values.length < 2) return null;
  const step = values[1] - values[0];
  for (let i = 2; i < values.length; i++) if (Math.abs(values[i] - values[i - 1] - step) > 1e-9 * Math.max(1, Math.abs(step))) return null;
  return step;
}

function numberSeries(field: Field, sources: number[], count: number): CellValue[] | null {
  const step = constantStep(sources);
  if (step === null) return null;
  const digits = field.type === "number" ? field.precision : 10;
  const last = sources.at(-1)!;
  return Array.from({ length: count }, (_, i) => roundTo(last + step * (i + 1), digits));
}

function dateSeries(sources: string[], count: number): CellValue[] | null {
  const dateOnly = sources.every(isDateOnly);
  const times = sources.map((value) => Date.parse(dateOnly ? `${value}T00:00:00Z` : value));
  if (times.some(Number.isNaN)) return null;
  const step = constantStep(times);
  if (step === null) return null;
  const last = times.at(-1)!;
  return Array.from({ length: count }, (_, i) => {
    const ms = last + step * (i + 1);
    // Date-only steps are whole days; formatting in UTC keeps them calendar dates.
    return dateOnly ? new Date(Math.round(ms / DAY_MS) * DAY_MS).toISOString().slice(0, 10) : new Date(ms).toISOString();
  });
}

export function fillSeries(field: Field, sources: CellValue[], count: number): CellValue[] {
  if (count <= 0 || sources.length === 0) return [];
  const filled = sources.every((value) => value !== null && value !== undefined);
  if (filled && (field.type === "number" || field.type === "currency") && sources.every((value) => typeof value === "number")) {
    const series = numberSeries(field, sources as number[], count);
    if (series) return series;
  }
  if (filled && field.type === "date" && sources.every((value) => typeof value === "string")) {
    const series = dateSeries(sources as string[], count);
    if (series) return series;
  }
  return Array.from({ length: count }, (_, i) => sources[i % sources.length] ?? null);
}
