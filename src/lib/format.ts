import type { CellValue } from "./domain/cell";
import type { Field } from "./domain/field";

/**
 * Cell value → display text, in the viewer's locale and the field's time zone.
 * Values are stored locale-neutral (see domain/cell.ts); only display is localized.
 *
 * `createCellFormatter` builds the Intl formatters once per field: creating them is
 * slow, and a screen of the grid formats ~1 000 cells on every scroll.
 */

export type FormatContext = {
  locale: string;
  /** The viewer's zone, for date-time fields that don't have their own. */
  timeZone: string;
  /** Primary values of linked records, by row id. */
  labelOf: (rowId: string) => string | undefined;
};

export type CellFormatter = (value: CellValue | undefined) => string;

function dateFormatters(locale: string, timeZone: string) {
  return {
    // Date-only values are calendar dates, formatted as UTC so they never shift a day.
    date: new Intl.DateTimeFormat(locale, { timeZone: "UTC", dateStyle: "medium" }),
    dateTime: new Intl.DateTimeFormat(locale, { timeZone, dateStyle: "medium", timeStyle: "short" }),
  };
}

function formatStoredDate(value: string, formatters: ReturnType<typeof dateFormatters>): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return formatters.date.format(new Date(`${value}T00:00:00Z`));
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? value : formatters.dateTime.format(ms);
}

export function createCellFormatter(field: Field, context: FormatContext): CellFormatter {
  const empty = (value: CellValue | undefined): value is null | undefined => value === null || value === undefined;

  switch (field.type) {
    case "number": {
      const format = new Intl.NumberFormat(context.locale, { minimumFractionDigits: field.precision, maximumFractionDigits: field.precision });
      return (value) => (typeof value === "number" ? format.format(value) : "");
    }
    case "currency": {
      const format = new Intl.NumberFormat(context.locale, { style: "currency", currency: field.currency });
      return (value) => (typeof value === "number" ? format.format(value) : "");
    }
    case "date": {
      const formatters = dateFormatters(context.locale, field.timeZone ?? context.timeZone);
      return (value) => (typeof value === "string" ? formatStoredDate(value, formatters) : "");
    }
    case "checkbox":
      return (value) => (value === true ? "✓" : "");
    case "singleSelect":
    case "multiSelect": {
      const labels = new Map(field.options.map((option) => [option.id, option.label]));
      return (value) => {
        if (empty(value)) return "";
        const ids = Array.isArray(value) ? value : [String(value)];
        return ids.map((id) => labels.get(id) ?? "").filter(Boolean).join(", ");
      };
    }
    case "link":
      return (value) => (Array.isArray(value) ? value.map((id) => context.labelOf(id) ?? "…").join(", ") : "");
    case "lookup":
      return (value) => (Array.isArray(value) ? value.join(", ") : empty(value) ? "" : String(value));
    case "formula": {
      if (field.resultType === "number") {
        const format = new Intl.NumberFormat(context.locale, { maximumFractionDigits: 4 });
        return (value) => (typeof value === "number" ? format.format(value) : "");
      }
      if (field.resultType === "date") {
        const formatters = dateFormatters(context.locale, context.timeZone);
        return (value) => (typeof value === "string" ? formatStoredDate(value, formatters) : "");
      }
      if (field.resultType === "checkbox") return (value) => (value === true ? "✓" : "");
      return (value) => (empty(value) ? "" : String(value));
    }
    default:
      return (value) => (empty(value) ? "" : String(value));
  }
}
