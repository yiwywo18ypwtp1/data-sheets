import { createCoercer, type CoerceOptions } from "@/lib/coerce/coerce";
import { roundTo } from "@/lib/coerce/numbers";
import { cellValueSchemaFor, type CellValue } from "@/lib/domain/cell";
import { isComputedField, type Field, type SelectOption } from "@/lib/domain/field";
import { formatStoredDate } from "@/lib/formula/dates";
import { wallTimeAt, wallTimeToInstant } from "@/lib/timezone";

/**
 * Field type change: converts each stored value of the old field into the new one.
 * Most conversions go through text (the value as a person would type it) and the same
 * coercer paste and import use, so "1 234,5" text becomes 1234.5 the same way everywhere.
 * A few keep more than text could: number ↔ currency, date ↔ date-time, select labels.
 */

export type ConvertResult = { ok: true; value: CellValue } | { ok: false; error: string };
export type Converter = (value: CellValue | undefined) => ConvertResult;

const OPTION_COLORS = ["#2563eb", "#16a34a", "#d97706", "#dc2626", "#7c3aed", "#0891b2", "#db2777", "#4b5563"];
export const MAX_OPTIONS = 200;

/** Why a conversion can't be done at all (rather than per value), or null. */
export function unsupportedConversion(from: Field, to: Field): string | null {
  if (to.type === "link" && from.type !== "link") return "Converting into a link field isn't supported; create a link field and import into it";
  if (from.type === "link" && to.type === "link" && from.targetTableId !== to.targetTableId) return "Changing the linked table isn't supported";
  return null;
}

/** The value as text, the way it's displayed (labels for selects and links, ISO for dates). */
export function valueAsText(field: Field, value: CellValue | undefined, labelOf: (rowId: string) => string | undefined): string {
  if (value === null || value === undefined) return "";
  switch (field.type) {
    case "singleSelect":
    case "multiSelect": {
      const ids = Array.isArray(value) ? value : [String(value)];
      return ids.map((id) => field.options.find((option) => option.id === id)?.label ?? "").filter(Boolean).join(", ");
    }
    case "link":
      return (Array.isArray(value) ? value : []).map((id) => labelOf(id) ?? "").filter(Boolean).join(", ");
    case "checkbox":
      return value === true ? "true" : "false";
    case "date":
      return typeof value === "string" ? value : "";
    default:
      return Array.isArray(value) ? value.join(", ") : String(value);
  }
}

/**
 * Options for a select made from text values: every distinct label (case-insensitive),
 * after the options it already has. Splits on commas for a multiple select.
 */
export function optionsFromValues(existing: SelectOption[], texts: Iterable<string>, multiple: boolean, newOptionId: (index: number) => string): SelectOption[] {
  const options = [...existing];
  const known = new Set(options.map((option) => option.label.trim().toLowerCase()));
  for (const text of texts) {
    for (const label of multiple ? text.split(/[,;\n]/) : [text]) {
      const trimmed = label.trim().slice(0, 100);
      if (trimmed === "" || known.has(trimmed.toLowerCase())) continue;
      known.add(trimmed.toLowerCase());
      options.push({ id: newOptionId(options.length), label: trimmed, color: OPTION_COLORS[options.length % OPTION_COLORS.length] });
    }
  }
  if (options.length > MAX_OPTIONS) throw new Error(`The values have ${options.length} different labels; a select can have at most ${MAX_OPTIONS}`);
  return options;
}

/** Date-only ↔ date-time, in the field's zone (or the viewer's). */
function convertDate(from: Extract<Field, { type: "date" }>, to: Extract<Field, { type: "date" }>, value: string, timeZone: string): ConvertResult {
  const fromZone = from.timeZone ?? timeZone;
  const toZone = to.timeZone ?? timeZone;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  if (!to.includeTime) {
    if (dateOnly) return { ok: true, value };
    const wall = wallTimeAt(Date.parse(value), fromZone);
    return { ok: true, value: formatStoredDate(Date.UTC(wall.year, wall.month - 1, wall.day), false) };
  }
  if (!dateOnly) return { ok: true, value };
  const [year, month, day] = value.split("-").map(Number);
  const ms = wallTimeToInstant({ year, month, day, hour: 0, minute: 0, second: 0 }, toZone) ?? wallTimeToInstant({ year, month, day, hour: 1, minute: 0, second: 0 }, toZone);
  return ms === null ? { ok: false, error: "No midnight on that day" } : { ok: true, value: new Date(ms).toISOString() };
}

/**
 * A converter from `from`'s stored values to `to`'s. `to` must already be complete
 * (select options generated). Computed targets aren't converted: they're recomputed.
 */
export function createConverter(from: Field, to: Field, options: CoerceOptions, labelOf: (rowId: string) => string | undefined): Converter {
  if (isComputedField(to)) return () => ({ ok: true, value: null });
  const coerce = createCoercer(to, options);
  const schema = cellValueSchemaFor(to);
  const viaText: Converter = (value) => {
    const text = valueAsText(from, value, labelOf);
    const result = coerce(text);
    return result.ok ? result : { ok: false, error: result.error };
  };

  return (value) => {
    if (value === null || value === undefined || value === "") return { ok: true, value: to.type === "checkbox" ? false : null };
    if (typeof value === "number" && (to.type === "number" || to.type === "currency")) {
      // Numbers stay numbers (not via locale text, where "1.234" could read as 1234), rounded to the new precision.
      const rounded = to.type === "number" ? roundTo(value, to.precision) : value;
      const checked = schema.safeParse(rounded);
      return checked.success ? { ok: true, value: rounded } : { ok: false, error: checked.error.issues[0]?.message ?? "Invalid value" };
    }
    if (typeof value === "number" && to.type === "checkbox") return { ok: true, value: value !== 0 };
    if (from.type === "date" && to.type === "date" && typeof value === "string") return convertDate(from, to, value, options.timeZone);
    if (from.type === "link" && to.type === "link" && Array.isArray(value)) {
      return to.multiple || value.length <= 1 ? { ok: true, value } : { ok: true, value: value.slice(0, 1) };
    }
    if (from.type === "multiSelect" && to.type === "singleSelect" && Array.isArray(value)) {
      // A single select keeps the first of several options.
      const result = coerce(valueAsText(from, value.slice(0, 1), labelOf));
      return result.ok ? result : { ok: false, error: result.error };
    }
    return viaText(value);
  };
}
