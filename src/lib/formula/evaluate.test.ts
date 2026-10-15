import { describe, expect, it } from "vitest";
import type { CellValue } from "@/lib/domain/cell";
import { MAX_FORMULA_LENGTH, type Field } from "@/lib/domain/field";
import { compileFormula } from "./compile";
import { evaluate, evaluateRowFormulas } from "./evaluate";
import { MAX_NESTING } from "./parser";
import { fieldByNameResolver } from "./references";
import { fromCellValue, type FormulaValue } from "./values";

const fields: Field[] = [
  { id: "a", name: "A", type: "number", precision: 2 },
  { id: "b", name: "B", type: "number", precision: 2 },
  { id: "empty", name: "Empty", type: "text" },
  { id: "first", name: "First", type: "text" },
  { id: "last", name: "Last", type: "text" },
  {
    id: "status",
    name: "Status",
    type: "singleSelect",
    options: [{ id: "opt_done", label: "Done", color: "#00aa00" }],
  },
  { id: "done", name: "Done", type: "checkbox" },
  { id: "start", name: "Start", type: "date", includeTime: false },
  { id: "at", name: "At", type: "date", includeTime: true },
  { id: "long", name: "Long", type: "text" },
];
const fieldsById = new Map(fields.map((field) => [field.id, field]));

const row: Record<string, CellValue> = {
  a: 10,
  b: 4,
  empty: null,
  first: "Ada",
  last: "Lovelace",
  status: "opt_done",
  done: null,
  start: "2026-01-31",
  at: "2026-03-29T00:30:00.000Z",
  long: "x".repeat(100_000),
};

const context = { now: new Date("2026-10-13T22:30:00.000Z") };

function run(expression: string, values: Record<string, CellValue> = row): FormulaValue {
  const compiled = compileFormula(expression, fieldByNameResolver(fields));
  return evaluate(compiled, (id) => fromCellValue(fieldsById.get(id)!, values[id]), context);
}

describe("evaluate", () => {
  it.each<[string, FormulaValue]>([
    ["{A} + {B} * 2", 18],
    ["{A} / {B}", 2.5],
    ["-{A} + 1", -9],
    ['{First} & " " & {Last}', "Ada Lovelace"],
    ['CONCAT({First}, " ", {Last})', "Ada Lovelace"],
    ['IF({Status} = "Done", {A} * {B}, 0)', 40],
    ["IF({Empty}, 1)", null],
    ["IF({Empty}, 1, 2)", 2],
    ["AND({A} > 5, {B} < 5)", true],
    ["OR({Done}, {A} = 0)", false],
    ["NOT({Done})", true],
    ["SUM({A}, {B}, {Empty}, 1)", 15],
    ["ROUND(1.005, 2)", 1.01],
    ["ROUND(-2.5)", -3],
    ["ROUND(1234, -2)", 1200],
    ["LEN({Long})", 100_000],
    ["UPPER({First})", "ADA"],
    ["LOWER(\"ÄB\")", "äb"],
    ["{Empty} = BLANK()", true],
    ['{Empty} = ""', true],
    ["{Empty} = 0", false],
    ["{Empty} < 5", false],
    ['"10" = 10', true],
    ['"b" > "a"', true],
    ["BLANK()", null],
    ["0.1 + 0.2", 0.3],
    ["{A} * 468.065", 4680.65],
    ['IF({A} > 100, "big", {A})', "10"],
    ['IF({A} > 5, TODAY(), "never")', "2026-10-13"],
  ])("%s = %j", (expression, expected) => {
    expect(run(expression)).toEqual(expected);
  });

  it("compiles and evaluates the deepest formulas the parser accepts", () => {
    expect(run(`1${"+1".repeat(MAX_NESTING - 1)}`)).toBe(MAX_NESTING);
    expect(run(`${"(".repeat(MAX_NESTING - 1)}1${")".repeat(MAX_NESTING - 1)}`)).toBe(1);
  });

  it("evaluates a chain of the maximum formula length (about 5 000 operators)", () => {
    const chain = `1${"+1".repeat(4999)}`;
    expect(chain.length).toBeLessThan(MAX_FORMULA_LENGTH);
    expect(run(chain)).toBe(5000);
    expect(run(`{A}${"+{B}".repeat(2000)}`)).toBe(8010);
    expect(run(`1${"+1".repeat(3000)}+{A}/0`)).toMatchObject({ code: "#DIV/0!" });
  });

  it("returns errors as values and propagates them", () => {
    expect(run("{A} / 0")).toMatchObject({ kind: "error", code: "#DIV/0!" });
    expect(run("({A} / 0) + 1")).toMatchObject({ code: "#DIV/0!" });
    expect(run("{A} + {First}")).toMatchObject({ code: "#VALUE!" });
    expect(run("SUM({A}, {First})")).toMatchObject({ code: "#VALUE!" });
    expect(run("{Start} < 5")).toMatchObject({ code: "#VALUE!" });
  });

  it("evaluates IF lazily, so a guarded division doesn't fail", () => {
    expect(run("IF({B} = 0, 0, {A} / {B})", { ...row, b: 0 })).toBe(0);
  });

  it("does date math in UTC regardless of the machine time zone", () => {
    expect(run('DATEADD({Start}, 7, "days")')).toEqual({ kind: "date", ms: Date.UTC(2026, 1, 7), hasTime: false });
    expect(run('DATEADD({Start}, 1, "month")')).toEqual({ kind: "date", ms: Date.UTC(2026, 1, 28), hasTime: false });
    expect(run('DATEADD({Start}, 1, "hours")')).toMatchObject({ hasTime: true });
    expect(run('DATETIME_DIFF("2026-03-01", {Start}, "days")')).toBe(29);
    expect(run('DATETIME_DIFF("2026-02-27", {Start}, "months")')).toBe(0);
    expect(run('DATETIME_DIFF("2026-02-28", {Start}, "months")')).toBe(1);
    expect(run('DATETIME_DIFF({Start}, "2027-01-31", "years")')).toBe(-1);
    expect(run('DATEADD({Start}, 1, {First})')).toMatchObject({ code: "#VALUE!" });
    expect(run('DATEADD({Empty}, 1, "day")')).toBeNull();
    expect(run('{Start} = "2026-01-31"')).toBe(true);
    expect(run('{At} > DATEADD({Start}, 1, "month")')).toBe(true);
  });

  it("uses the context clock and time zone for TODAY()", () => {
    expect(run("TODAY()")).toEqual({ kind: "date", ms: Date.UTC(2026, 9, 13), hasTime: false });
    const compiled = compileFormula("TODAY()", () => undefined);
    expect(evaluate(compiled, () => null, { ...context, timeZone: "Pacific/Auckland" })).toEqual({
      kind: "date",
      ms: Date.UTC(2026, 9, 14),
      hasTime: false,
    });
  });
});

describe("evaluateRowFormulas", () => {
  const table: Field[] = [
    { id: "price", name: "Price", type: "number", precision: 2 },
    { id: "qty", name: "Qty", type: "number", precision: 0 },
    { id: "subtotal", name: "Subtotal", type: "formula", expression: "{price} * {qty}", resultType: "number" },
    { id: "tax", name: "Tax", type: "formula", expression: "{subtotal} * 0.2", resultType: "number" },
    { id: "broken", name: "Broken", type: "formula", expression: "{deleted} + 1", resultType: "number" },
  ];
  const byId = new Map(table.map((field) => [field.id, field]));

  it("feeds earlier formula results into later ones", () => {
    const results = evaluateRowFormulas(["subtotal", "tax"], { price: 10, qty: 3 }, byId, context);
    expect(results.get("subtotal")).toBe(30);
    expect(results.get("tax")).toBe(6);
  });

  it("turns a formula referencing a deleted field into a #REF! error instead of throwing", () => {
    const results = evaluateRowFormulas(["broken"], {}, byId, context);
    expect(results.get("broken")).toMatchObject({ kind: "error", code: "#REF!", message: 'Unknown field "deleted"' });
  });
});
