import { cellValueSchemaFor, type CellValue } from "@/lib/domain/cell";
import type { Field } from "@/lib/domain/field";
import { dateOrder, parseDateInput } from "./dates";
import { numberLocale, parseLocaleNumber, roundTo } from "./numbers";

export type CoerceOptions = {
  /** The user's locale: decides "1,234" vs "1.234" and day/month order. */
  locale: string;
  /** The viewer's time zone, used for date fields that don't have their own. */
  timeZone: string;
};

/** A failed cell keeps its error, so paste and import can highlight it instead of silently emptying it. */
export type CoerceResult = { ok: true; value: CellValue } | { ok: false; error: string };

const TRUE_WORDS = new Set(["true", "yes", "y", "1", "x", "✓", "✔", "checked", "on", "да", "так"]);
const FALSE_WORDS = new Set(["false", "no", "n", "0", "unchecked", "off", "нет", "ні"]);

const ok = (value: CellValue): CoerceResult => ({ ok: true, value });
const fail = (error: string): CoerceResult => ({ ok: false, error });

/** Fraction digits a currency normally uses: 2 for USD, 0 for JPY. */
function currencyDigits(currency: string): number {
  return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
}

/** Strips currency symbols and codes around the amount: "$1,234.50", "1 234,50 грн", "USD 12". */
function stripCurrency(text: string): string {
  return text
    .replace(/\p{Sc}/gu, "")
    .replace(/^\s*\p{L}{1,4}\.?\s*/u, "")
    .replace(/\s*\p{L}{1,4}\.?\s*$/u, "");
}

/** A bare domain pasted from a sheet ("example.com/page") is meant as an https link. */
function withScheme(text: string): string {
  return /^[a-z][a-z\d+.-]*:/i.test(text) ? text : `https://${text}`;
}

/**
 * Builds a text → cell value converter for one field. It's a factory because the
 * locale lookups and option maps are expensive to rebuild for each of 10k pasted cells:
 * build one coercer per column, then call it per cell.
 *
 * Used by cell editors, clipboard paste and CSV import. Every result is finally
 * checked by the same `cellValueSchemaFor` the server uses.
 */
export function createCoercer(field: Field, options: CoerceOptions): (text: string) => CoerceResult {
  const schema = cellValueSchemaFor(field);
  const convert = converterFor(field, options);

  return (input) => {
    if (input.trim() === "") return ok(field.type === "checkbox" ? false : null);
    const result = convert(input);
    if (!result.ok) return result;
    const checked = schema.safeParse(result.value);
    return checked.success ? result : fail(checked.error.issues[0]?.message ?? "Invalid value");
  };
}

function converterFor(field: Field, options: CoerceOptions): (text: string) => CoerceResult {
  switch (field.type) {
    case "text":
      return (text) => ok(text);

    case "number": {
      const locale = numberLocale(options.locale);
      return (text) => {
        const value = parseLocaleNumber(text, locale);
        // Extra decimals are rounded to the field's precision, like a spreadsheet would.
        return value === null ? fail(`"${text}" is not a number`) : ok(roundTo(value, field.precision));
      };
    }

    case "currency": {
      const locale = numberLocale(options.locale);
      const digits = currencyDigits(field.currency);
      return (text) => {
        const value = parseLocaleNumber(stripCurrency(text), locale);
        return value === null ? fail(`"${text}" is not an amount`) : ok(roundTo(value, digits));
      };
    }

    case "date": {
      const target = {
        includeTime: field.includeTime,
        timeZone: field.timeZone ?? options.timeZone,
        order: dateOrder(options.locale),
      };
      return (text) => {
        const result = parseDateInput(text, target);
        return result.ok ? ok(result.value) : fail(result.error);
      };
    }

    case "checkbox":
      return (text) => {
        const word = text.trim().toLowerCase();
        if (TRUE_WORDS.has(word)) return ok(true);
        if (FALSE_WORDS.has(word)) return ok(false);
        return fail(`"${text}" is not yes/no`);
      };

    case "singleSelect": {
      const byLabel = new Map(field.options.map((option) => [option.label.trim().toLowerCase(), option.id]));
      return (text) => {
        const id = byLabel.get(text.trim().toLowerCase());
        return id ? ok(id) : fail(`No option "${text.trim()}"`);
      };
    }

    case "multiSelect": {
      const byLabel = new Map(field.options.map((option) => [option.label.trim().toLowerCase(), option.id]));
      return (text) => {
        const labels = text.split(/[,;\n]/).map((label) => label.trim()).filter(Boolean);
        const missing = labels.filter((label) => !byLabel.has(label.toLowerCase()));
        if (missing.length > 0) return fail(`No option ${missing.map((label) => `"${label}"`).join(", ")}`);
        return ok([...new Set(labels.map((label) => byLabel.get(label.toLowerCase())!))]);
      };
    }

    case "email":
      return (text) => ok(text.trim());

    case "url":
      return (text) => ok(withScheme(text.trim()));

    case "link":
      // Matching text to records needs the target table, so it can't happen in this pure module.
      return () => fail("Linked records can't be set from text");

    case "lookup":
    case "formula":
      return () => fail("Computed field can't be edited");
  }
}
