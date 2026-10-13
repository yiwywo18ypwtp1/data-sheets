import type { CellValue } from "@/lib/domain/cell";
import type { Field } from "@/lib/domain/field";
import { formatStoredDate, parseStoredDate } from "./dates";

/** A date during evaluation. `hasTime: false` means a calendar date at UTC midnight. */
export type FormulaDate = { kind: "date"; ms: number; hasTime: boolean };

export type FormulaErrorCode = "#DIV/0!" | "#VALUE!" | "#NUM!" | "#REF!" | "#ERROR!";

/**
 * Runtime errors are values, not exceptions: `{A} / 0` yields `#DIV/0!` for that
 * cell and the error propagates through any expression that uses it.
 */
export type FormulaError = { kind: "error"; code: FormulaErrorCode; message: string };

/** `null` is blank (an empty cell or BLANK()). */
export type FormulaValue = number | string | boolean | null | FormulaDate | FormulaError;

export function formulaError(code: FormulaErrorCode, message: string): FormulaError {
  return { kind: "error", code, message };
}

/** Accepts any value so helpers returning `T | FormulaError` (e.g. `number[] | FormulaError`) can be narrowed. */
export function isFormulaError(value: unknown): value is FormulaError {
  return typeof value === "object" && value !== null && "kind" in value && value.kind === "error";
}

export function isFormulaDate(value: FormulaValue): value is FormulaDate {
  return typeof value === "object" && value !== null && value.kind === "date";
}

export function formulaDate(ms: number, hasTime: boolean): FormulaDate {
  return { kind: "date", ms, hasTime };
}

/** Coercions used by operators and functions. Errors are checked by the caller before coercing. */
export function toNumber(value: Exclude<FormulaValue, FormulaError>): number | FormulaError {
  if (value === null) return 0;
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") {
    const trimmed = value.trim();
    const number = trimmed === "" ? 0 : Number(trimmed);
    return Number.isNaN(number) ? formulaError("#VALUE!", `"${value.slice(0, 20)}" is not a number`) : number;
  }
  return formulaError("#VALUE!", "Use DATEADD or DATETIME_DIFF for date math");
}

export function toText(value: Exclude<FormulaValue, FormulaError>): string {
  if (value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return formatStoredDate(value.ms, value.hasTime);
}

export function isTruthy(value: Exclude<FormulaValue, FormulaError>): boolean {
  if (value === null) return false;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value !== "";
  if (typeof value === "boolean") return value;
  return true;
}

/** Converts a stored cell value into what formulas see: option labels instead of ids, dates as dates. */
export function fromCellValue(field: Field, value: CellValue | undefined): FormulaValue {
  if (value === null || value === undefined) return field.type === "checkbox" ? false : null;

  switch (field.type) {
    case "singleSelect":
      return field.options.find((option) => option.id === value)?.label ?? null;
    case "multiSelect":
      return Array.isArray(value)
        ? value.map((id) => field.options.find((option) => option.id === id)?.label ?? "").filter(Boolean).join(", ")
        : null;
    case "lookup":
      return Array.isArray(value) ? value.join(", ") : value;
    case "link":
      // Links are rejected by the type checker; this only guards against stale data.
      return Array.isArray(value) ? value.length : null;
    case "date": {
      const parsed = typeof value === "string" ? parseStoredDate(value) : null;
      return parsed ? formulaDate(parsed.ms, parsed.hasTime) : null;
    }
    case "formula": {
      if (field.resultType === "date" && typeof value === "string") {
        const parsed = parseStoredDate(value);
        return parsed ? formulaDate(parsed.ms, parsed.hasTime) : null;
      }
      return Array.isArray(value) ? value.join(", ") : value;
    }
    default:
      return Array.isArray(value) ? value.join(", ") : value;
  }
}

/** Converts a non-error result into a storable cell value. Errors are stored separately by the caller. */
export function toCellValue(value: Exclude<FormulaValue, FormulaError>): CellValue {
  if (isFormulaDate(value)) return formatStoredDate(value.ms, value.hasTime);
  return value;
}
