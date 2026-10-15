import { describe, expect, it } from "vitest";
import type { Field } from "@/lib/domain/field";
import { compileFormula } from "./compile";
import { fieldByNameResolver, toDisplayExpression, toStoredExpression } from "./references";

const fields: Field[] = [
  { id: "fld_status", name: "Status", type: "singleSelect", options: [] },
  { id: "fld_price", name: "Price", type: "currency", currency: "USD" },
  { id: "fld_qty", name: "Qty", type: "number", precision: 0 },
  { id: "fld_start", name: "Start", type: "date", includeTime: false },
  { id: "fld_customer", name: "Customer", type: "link", targetTableId: "tbl_c", multiple: false },
  { id: "fld_total", name: "Total", type: "formula", expression: "{fld_price} * {fld_qty}", resultType: "number" },
];
const byName = fieldByNameResolver(fields);

describe("compileFormula", () => {
  it.each([
    ['IF({Status} = "Done", {Price} * {Qty}, 0)', "number"],
    ['DATEADD({Start}, 7, "days")', "date"],
    ['CONCAT({Status}, " ", {Qty})', "text"],
    ["{Total} > 100", "checkbox"],
    ["IF({Qty}, 1)", "number"],
    ['IF({Qty}, 1, "many")', "text"],
    ["BLANK()", "text"],
  ])("%s has result type %s", (expression, resultType) => {
    expect(compileFormula(expression, byName).resultType).toBe(resultType);
  });

  it("collects referenced field ids once and rewrites refs to ids", () => {
    const compiled = compileFormula("{Price} * {qty} + {Price}", byName);
    expect(compiled.fieldIds).toEqual(["fld_price", "fld_qty"]);
    expect(compiled.ast).toMatchObject({ left: { left: { ref: "fld_price" } } });
  });

  it("reports an unknown field with its position", () => {
    expect(() => compileFormula('IF({Status} = "Done", {Prise} * {Qty}, 0)', byName)).toThrow(
      'Unknown field "Prise" at 22',
    );
  });

  it("treats a field of another table as unknown", () => {
    expect(() => compileFormula("{Customer name}", byName)).toThrow('Unknown field "Customer name" at 0');
  });

  it("rejects links, unknown functions, bad arity and date arithmetic", () => {
    expect(() => compileFormula("{Customer}", byName)).toThrow("add a lookup field at 0");
    expect(() => compileFormula("FOO(1)", byName)).toThrow('Unknown function "FOO" at 0');
    expect(() => compileFormula("1 + ROUND()", byName)).toThrow("ROUND expects 1 to 2 arguments at 4");
    expect(() => compileFormula("NOT(1, 2)", byName)).toThrow("NOT expects 1 argument at 0");
    expect(() => compileFormula("{Start} + 7", byName)).toThrow("Use DATEADD or DATETIME_DIFF for date math at 0");
  });
});

describe("argument types", () => {
  it.each([
    ['SUM({Qty}, "a")', 'Expected a number, found "a" at 11'],
    ['{Qty} + "abc"', 'Expected a number, found "abc" at 8'],
    ['-"x"', 'Expected a number, found "x" at 1'],
    ["ROUND({Start})", "Use DATEADD or DATETIME_DIFF for date math at 6"],
    ["SUM({Start}, 1)", "Use DATEADD or DATETIME_DIFF for date math at 4"],
    ['DATEADD(5, 1, "days")', "Expected a date at 8"],
    ['DATEADD("tomorrow", 1, "days")', 'Expected a date, found "tomorrow" at 8'],
    ['DATEADD({Start}, "x", "days")', 'Expected a number, found "x" at 17'],
    ['DATEADD({Start}, 1, "fortnight")', "Expected a unit"],
    ["DATETIME_DIFF({Start}, {Qty}, 3)", "Expected a date at 23"],
  ])("rejects %s", (expression, message) => {
    expect(() => compileFormula(expression, byName)).toThrow(message);
  });

  it.each([
    'SUM({Qty}, "2", TRUE, {Status})', // text fields and numeric text may hold numbers: decided per row
    'ROUND("1.5", 0)',
    'DATEADD("2026-01-31", 1, "Month")',
    'DATEADD({Status}, {Qty}, {Status})',
    'DATEADD("", 1, "days")',
    'DATETIME_DIFF(TODAY(), {Start}, "days")',
    'CONCAT({Start}, 1, TRUE)',
  ])("accepts %s", (expression) => {
    expect(() => compileFormula(expression, byName)).not.toThrow();
  });
});

describe("volatile formulas", () => {
  it.each([
    ["TODAY()", true],
    ['DATETIME_DIFF({Start}, TODAY(), "days")', true],
    ["IF({Qty} > 1, 1, DATETIME_DIFF(TODAY(), {Start}, \"days\"))", true],
    ["{Price} * {Qty}", false],
    ['DATEADD({Start}, 7, "days")', false],
  ])("%s is volatile: %s", (expression, volatile) => {
    expect(compileFormula(expression, byName).volatile).toBe(volatile);
  });
});

describe("stored expressions", () => {
  it("converts names to ids and back, so renaming a field keeps the formula working", () => {
    const stored = toStoredExpression('{Price} * {qty} & "{Price}"', fields);
    expect(stored).toBe('{fld_price} * {fld_qty} & "{Price}"');

    const renamed = fields.map((field) => (field.id === "fld_price" ? { ...field, name: "Unit price" } : field));
    expect(toDisplayExpression(stored, renamed)).toBe('{Unit price} * {Qty} & "{Price}"');
  });

  it("keeps the id of a deleted field visible", () => {
    const withoutQty = fields.filter((field) => field.id !== "fld_qty");
    expect(toDisplayExpression("{fld_price} * {fld_qty}", withoutQty)).toBe("{Price} * {fld_qty}");
  });

  it("reports unknown names with a position", () => {
    expect(() => toStoredExpression("1 + {Nope}", fields)).toThrow('Unknown field "Nope" at 4');
  });
});
