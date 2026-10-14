import type { CellValue } from "@/lib/domain/cell";
import type { Field } from "@/lib/domain/field";

/**
 * Cell values → CSV text for the export. Unlike the grid's display text, the export
 * is meant to be read back (by this app's import, a spreadsheet, a script), so values
 * stay unambiguous and locale-neutral: plain numbers ("1234.5", no grouping, no
 * currency sign), ISO dates, date-times as "YYYY-MM-DD HH:mm" in the field's zone,
 * checkboxes as true/false. Selects and links are written by label, as the import
 * expects them.
 */

export type ExportContext = {
  /** The viewer's zone, for date-time fields without their own (and date formulas). */
  timeZone: string;
  /** Primary values of linked records, by row id. */
  labelOf: (rowId: string) => string | undefined;
};

/** Format of one column: the stored value (and the formula error, if any) → text. */
export type ExportFormatter = (value: CellValue | undefined, error?: string) => string;

/**
 * Spreadsheets run a cell that starts with = + - @ (or a tab / CR) as a formula
 * ("CSV injection"). Text values get a leading apostrophe, which Excel and Sheets show
 * as plain text. Numbers are written by us and are never touched.
 */
export function guardFormula(text: string): string {
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

const pad = (n: number) => String(n).padStart(2, "0");

function dateTimeFormatter(timeZone: string) {
  const format = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return (iso: string) => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) return iso;
    const parts = Object.fromEntries(format.formatToParts(ms).map((part) => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day} ${pad(Number(parts.hour))}:${parts.minute}`;
  };
}

/** Numbers as JavaScript writes them, without exponent notation for very large or small ones. */
function plainNumber(value: number): string {
  if (!Number.isFinite(value)) return "";
  const text = String(value);
  return /e/i.test(text) ? value.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 20 }) : text;
}

export function createExportFormatter(field: Field, context: ExportContext): ExportFormatter {
  const empty = (value: CellValue | undefined): value is null | undefined => value === null || value === undefined;
  const text = (value: CellValue | undefined) => (empty(value) ? "" : guardFormula(Array.isArray(value) ? value.join(", ") : String(value)));

  switch (field.type) {
    case "number":
    case "currency":
      return (value) => (typeof value === "number" ? plainNumber(value) : "");
    case "date": {
      const format = dateTimeFormatter(field.timeZone ?? context.timeZone);
      return (value) => (typeof value === "string" ? format(value) : "");
    }
    case "checkbox":
      return (value) => (value === true ? "true" : "false");
    case "singleSelect":
    case "multiSelect": {
      const labels = new Map(field.options.map((option) => [option.id, option.label]));
      return (value) => {
        if (empty(value)) return "";
        const ids = Array.isArray(value) ? value : [String(value)];
        return guardFormula(ids.flatMap((id) => labels.get(id) ?? []).join(", "));
      };
    }
    case "link":
      return (value) => (Array.isArray(value) ? guardFormula(value.map((id) => context.labelOf(id) ?? "").filter(Boolean).join(", ")) : "");
    case "lookup":
      return (value) => (Array.isArray(value) ? guardFormula(value.map((item) => (typeof item === "number" ? plainNumber(item) : String(item))).join(", ")) : text(value));
    case "formula": {
      // A failed formula has no value; its error code (#DIV/0!) is what the grid shows.
      const withError = (format: ExportFormatter): ExportFormatter => (value, error) => (error ? error.split(" ")[0] : format(value));
      if (field.resultType === "number") return withError((value) => (typeof value === "number" ? plainNumber(value) : ""));
      if (field.resultType === "date") {
        const format = dateTimeFormatter(context.timeZone);
        return withError((value) => (typeof value === "string" ? format(value) : ""));
      }
      if (field.resultType === "checkbox") return withError((value) => (value === true ? "true" : "false"));
      return withError(text);
    }
    default:
      return text;
  }
}

/** RFC 4180: a cell with a delimiter, quote or line break is quoted, quotes doubled. */
export function csvCell(text: string): string {
  return /[",\r\n]/.test(text) || /^\s|\s$/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function csvLine(cells: string[]): string {
  return `${cells.map(csvCell).join(",")}\r\n`;
}

/** Excel opens a UTF-8 CSV as UTF-8 only with a byte order mark. */
export const UTF8_BOM = "\uFEFF";
