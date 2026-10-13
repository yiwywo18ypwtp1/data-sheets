/**
 * Parses numbers as people type or paste them from Excel / Google Sheets:
 * "1 234,50", "1,234.50", "1.234,50", "-12", "(12)" (accounting negative), "1'234.5".
 */

export type NumberLocale = { decimal: string; group: string };

export function numberLocale(locale: string): NumberLocale {
  const parts = new Intl.NumberFormat(locale).formatToParts(12345.6);
  return {
    decimal: parts.find((part) => part.type === "decimal")?.value ?? ".",
    group: parts.find((part) => part.type === "group")?.value ?? ",",
  };
}

/**
 * Decides which of "." / "," is the decimal separator:
 * - both present: the last one is decimal ("1.234,5" and "1,234.5")
 * - one present several times: it's a group separator ("1,234,567")
 * - one present once: decimal, unless it isn't the locale's decimal and exactly
 *   three digits follow ("1,234" is 1234 in en-US but 1.234 in uk-UA)
 */
function decimalSeparatorOf(text: string, locale: NumberLocale): "." | "," | null {
  const lastDot = text.lastIndexOf(".");
  const lastComma = text.lastIndexOf(",");
  if (lastDot !== -1 && lastComma !== -1) return lastDot > lastComma ? "." : ",";

  const separator = lastDot !== -1 ? "." : lastComma !== -1 ? "," : null;
  if (separator === null) return null;
  if (text.indexOf(separator) !== text.lastIndexOf(separator)) return null;
  const digitsAfter = text.length - text.lastIndexOf(separator) - 1;
  return separator !== locale.decimal && digitsAfter === 3 ? null : separator;
}

export function parseLocaleNumber(input: string, locale: NumberLocale): number | null {
  let text = input.trim().replace(/−/g, "-"); // typographic minus
  let negative = false;

  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }
  if (text.startsWith("-")) {
    negative = !negative;
    text = text.slice(1);
  } else if (text.startsWith("+")) {
    text = text.slice(1);
  }

  // Group separators that can't be confused with a decimal: spaces (incl. non-breaking) and apostrophes.
  text = text.replace(/[\s  '’]/g, "");
  if (!/^[\d.,]+$/.test(text) || !/\d/.test(text)) return null;

  const decimal = decimalSeparatorOf(text, locale);
  const normalized =
    decimal === null
      ? text.replace(/[.,]/g, "")
      : text.replaceAll(decimal === "." ? "," : ".", "").replace(decimal, ".");
  if (!/^\d*\.?\d*$/.test(normalized)) return null;

  const value = Number(normalized);
  if (!Number.isFinite(value)) return null;
  return negative ? -value : value;
}

/** Rounds half away from zero; `toPrecision` cancels binary noise (1.005 → 1.01). */
export function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return (Math.sign(value) * Math.round(Number((Math.abs(value) * factor).toPrecision(15)))) / factor;
}
