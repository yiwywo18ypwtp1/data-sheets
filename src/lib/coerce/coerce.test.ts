import { describe, expect, it } from "vitest";
import type { Field } from "@/lib/domain/field";
import { createCoercer, type CoerceOptions, type CoerceResult } from "./coerce";
import { numberLocale, parseLocaleNumber } from "./numbers";

const uk: CoerceOptions = { locale: "uk-UA", timeZone: "Europe/Kyiv" };
const us: CoerceOptions = { locale: "en-US", timeZone: "America/Los_Angeles" };

const value = (result: CoerceResult) => (result.ok ? result.value : `error: ${result.error}`);
const coerce = (field: Field, text: string, options = uk) => value(createCoercer(field, options)(text));

describe("parseLocaleNumber", () => {
  const ukLocale = numberLocale("uk-UA");
  const usLocale = numberLocale("en-US");

  it.each([
    ["1 234,50", ukLocale, 1234.5],
    ["1 234,50", ukLocale, 1234.5],
    ["1 234,5", ukLocale, 1234.5],
    ["1,234.50", ukLocale, 1234.5],
    ["1.234,50", usLocale, 1234.5],
    ["1,234,567", usLocale, 1234567],
    ["1,234", usLocale, 1234],
    ["1,234", ukLocale, 1.234],
    ["1.234", ukLocale, 1234],
    ["1.5", ukLocale, 1.5],
    ["1'234.5", usLocale, 1234.5],
    ["-12", usLocale, -12],
    ["−12", usLocale, -12],
    ["(1,234.50)", usLocale, -1234.5],
    ["+7", usLocale, 7],
    [".5", usLocale, 0.5],
  ])("%j → %d", (text, locale, expected) => {
    expect(parseLocaleNumber(text, locale)).toBe(expected);
  });

  // A separator that isn't the decimal one must group thousands: "12.03.2026" is a date, not 12032026.
  it.each(["abc", "1.2.3,4,5", "12abc", "-", "1,2,3.4.5", "", "12.03.2026", "1,23,456", "12.3456,5"])("rejects %j", (text) => {
    expect(parseLocaleNumber(text, usLocale)).toBeNull();
  });
});

describe("createCoercer", () => {
  it("parses numbers with the user's locale, rounds to precision and checks bounds", () => {
    const field: Field = { id: "f", name: "N", type: "number", precision: 2, min: 0, max: 10_000 };
    expect(coerce(field, "1 234,50")).toBe(1234.5);
    expect(coerce(field, "1,005", us)).toBe(1005);
    expect(coerce(field, "1,005")).toBe(1.01);
    expect(coerce(field, "-1")).toBe("error: Must be ≥ 0");
    expect(coerce(field, "lots")).toBe('error: "lots" is not a number');
  });

  it("strips currency symbols and codes and rounds to the currency's digits", () => {
    const usd: Field = { id: "f", name: "C", type: "currency", currency: "USD" };
    const jpy: Field = { id: "f", name: "C", type: "currency", currency: "JPY" };
    expect(coerce(usd, "$1,234.567", us)).toBe(1234.57);
    expect(coerce(usd, "1 234,50 грн")).toBe(1234.5);
    expect(coerce(usd, "USD 12", us)).toBe(12);
    expect(coerce(jpy, "¥1,234.5", us)).toBe(1235);
  });

  it("reads numeric dates in the locale's day/month order", () => {
    const field: Field = { id: "f", name: "D", type: "date", includeTime: false };
    expect(coerce(field, "12/03/2026")).toBe("2026-03-12");
    expect(coerce(field, "12/03/2026", us)).toBe("2026-12-03");
    expect(coerce(field, "12.03.26")).toBe("2026-03-12");
    expect(coerce(field, "2026-03-12")).toBe("2026-03-12");
    expect(coerce(field, "2026/03/12", us)).toBe("2026-03-12");
    expect(coerce(field, "12/03/2026 0:00")).toBe("2026-03-12");
    expect(coerce(field, "31/02/2026")).toBe('error: "31/02/2026" is not a date');
    expect(coerce(field, "13/25/2026", us)).toBe('error: "13/25/2026" is not a date');
  });

  it("interprets typed times in the field's time zone", () => {
    const berlin: Field = { id: "f", name: "D", type: "date", includeTime: true, timeZone: "Europe/Berlin" };
    expect(coerce(berlin, "2026-01-15 14:30")).toBe("2026-01-15T13:30:00.000Z");
    expect(coerce(berlin, "01/15/2026 2:30 PM", us)).toBe("2026-01-15T13:30:00.000Z");
    expect(coerce(berlin, "2026-01-15")).toBe("2026-01-14T23:00:00.000Z");
    expect(coerce(berlin, "2026-01-15T14:30:00Z")).toBe("2026-01-15T14:30:00.000Z");
    expect(coerce(berlin, "2026-01-15 25:00")).toBe('error: "25:00" is not a time');
  });

  it("falls back to the viewer's zone when the field has none", () => {
    const field: Field = { id: "f", name: "D", type: "date", includeTime: true };
    expect(coerce(field, "2026-07-01 12:00", us)).toBe("2026-07-01T19:00:00.000Z");
  });

  it("handles DST edges in Europe/Berlin explicitly", () => {
    const field: Field = { id: "f", name: "D", type: "date", includeTime: true, timeZone: "Europe/Berlin" };
    expect(coerce(field, "2026-03-29 02:30")).toBe(
      "error: 2026-03-29 02:30 doesn't exist in Europe/Berlin (clocks skip it)",
    );
    expect(coerce(field, "2026-10-25 02:30")).toBe("2026-10-25T00:30:00.000Z");
  });

  it("converts an instant to the field zone's calendar date for date-only fields", () => {
    const field: Field = { id: "f", name: "D", type: "date", includeTime: false, timeZone: "Pacific/Auckland" };
    expect(coerce(field, "2026-01-15T20:00:00Z")).toBe("2026-01-16");
  });

  it("understands common yes/no words and treats empty as unchecked", () => {
    const field: Field = { id: "f", name: "B", type: "checkbox" };
    expect(coerce(field, "Yes")).toBe(true);
    expect(coerce(field, "✓")).toBe(true);
    expect(coerce(field, "ні")).toBe(false);
    expect(coerce(field, "")).toBe(false);
    expect(coerce(field, "maybe")).toBe('error: "maybe" is not yes/no');
  });

  it("matches select options by label, case-insensitively", () => {
    const options = [
      { id: "o1", label: "In progress", color: "#000000" },
      { id: "o2", label: "Done", color: "#000000" },
    ];
    const single: Field = { id: "f", name: "S", type: "singleSelect", options };
    const multi: Field = { id: "f", name: "M", type: "multiSelect", options };
    expect(coerce(single, " in PROGRESS ")).toBe("o1");
    expect(coerce(single, "Blocked")).toBe('error: No option "Blocked"');
    expect(coerce(multi, "Done, in progress; done")).toEqual(["o2", "o1"]);
    expect(coerce(multi, "Done, Nope, Meh")).toBe('error: No option "Nope", "Meh"');
  });

  it("validates emails and urls, adding https to bare domains", () => {
    const email: Field = { id: "f", name: "E", type: "email" };
    const url: Field = { id: "f", name: "U", type: "url" };
    expect(coerce(email, " ada@example.com ")).toBe("ada@example.com");
    expect(value(createCoercer(email, uk)("not-an-email"))).toMatch(/^error:/);
    expect(coerce(url, "example.com/page")).toBe("https://example.com/page");
    expect(value(createCoercer(url, uk)("javascript:alert(1)"))).toMatch(/^error:/);
  });

  it("enforces text max length instead of truncating", () => {
    const field: Field = { id: "f", name: "T", type: "text", maxLength: 3 };
    expect(coerce(field, "abc")).toBe("abc");
    expect(value(createCoercer(field, uk)("abcd"))).toMatch(/^error:/);
  });

  it("turns empty text into an empty cell", () => {
    expect(coerce({ id: "f", name: "N", type: "number", precision: 0 }, "  ")).toBeNull();
  });

  it("refuses links and computed fields", () => {
    expect(coerce({ id: "f", name: "L", type: "link", targetTableId: "t", multiple: true }, "Ada")).toMatch(/^error:/);
    expect(coerce({ id: "f", name: "F", type: "formula", expression: "1", resultType: "number" }, "1")).toBe(
      "error: Computed field can't be edited",
    );
  });
});
