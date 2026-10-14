import { describe, expect, it } from "vitest";
import type { Field } from "@/lib/domain/field";
import { createCoercer } from "@/lib/coerce/coerce";
import { createExportFormatter, csvCell, csvLine, guardFormula } from "./csv";

const context = { timeZone: "UTC", labelOf: (id: string) => ({ row_1: "Ann", row_2: "Bob, Jr." })[id] };
const format = (field: Field, value: unknown, error?: string) => createExportFormatter(field, context)(value as never, error);

describe("CSV export formatting", () => {
  it("quotes cells with delimiters, quotes, line breaks and edge spaces (RFC 4180)", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell('say "hi", ok')).toBe('"say ""hi"", ok"');
    expect(csvCell("two\nlines")).toBe('"two\nlines"');
    expect(csvCell(" padded")).toBe('" padded"');
    expect(csvLine(["a", "b,c"])).toBe('a,"b,c"\r\n');
  });

  it("neutralises text that a spreadsheet would run as a formula", () => {
    expect(guardFormula("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(guardFormula("@SUM")).toBe("'@SUM");
    expect(format({ id: "f", name: "T", type: "text" }, "-1+2")).toBe("'-1+2");
    // Numbers are ours, never guarded.
    expect(format({ id: "f", name: "N", type: "number", precision: 2 }, -1.5)).toBe("-1.5");
  });

  it("writes locale-neutral values the import reads back", () => {
    const berlin: Field = { id: "f", name: "At", type: "date", includeTime: true, timeZone: "Europe/Berlin" };
    expect(format(berlin, "2026-03-29T00:30:00.000Z")).toBe("2026-03-29 01:30");
    expect(format({ id: "f", name: "D", type: "date", includeTime: false }, "2026-10-25")).toBe("2026-10-25");
    expect(format({ id: "f", name: "C", type: "currency", currency: "USD" }, 1234567.5)).toBe("1234567.5");
    expect(format({ id: "f", name: "N", type: "number", precision: 0 }, 1e21)).toBe("1000000000000000000000");
    expect(format({ id: "f", name: "B", type: "checkbox" }, null)).toBe("false");

    const coerceDate = createCoercer(berlin, { locale: "uk-UA", timeZone: "UTC" });
    expect(coerceDate("2026-03-29 01:30")).toEqual({ ok: true, value: "2026-03-29T00:30:00.000Z" });
  });

  it("writes selects and links by label and formula errors by code", () => {
    const status: Field = { id: "f", name: "S", type: "multiSelect", options: [{ id: "opt_a", label: "New", color: "blue" }, { id: "opt_b", label: "Done", color: "green" }] };
    expect(format(status, ["opt_b", "opt_a", "opt_gone"])).toBe("Done, New");
    expect(format({ id: "f", name: "L", type: "link", targetTableId: "t", multiple: true }, ["row_1", "row_2"])).toBe("Ann, Bob, Jr.");
    const formula: Field = { id: "f", name: "F", type: "formula", expression: "1/0", resultType: "number" };
    expect(format(formula, null, "#DIV/0! Division by zero")).toBe("#DIV/0!");
    expect(format(formula, 0.1 + 0.2)).toBe("0.30000000000000004");
  });
});
