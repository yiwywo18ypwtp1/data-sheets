import { describe, expect, it } from "vitest";
import type { Field } from "@/lib/domain/field";
import type { Row } from "@/lib/domain/row";
import { buildFormulaContext, displayRow } from "./optimistic";

const fields: Field[] = [
  { id: "qty", name: "Qty", type: "number", precision: 0 },
  { id: "price", name: "Price", type: "number", precision: 2 },
  { id: "total", name: "Total", type: "formula", expression: "{qty} * {price}", resultType: "number" },
  { id: "ratio", name: "Ratio", type: "formula", expression: "{price} / {qty}", resultType: "number" },
  { id: "note", name: "Note", type: "text" },
];
const context = buildFormulaContext(fields);
const now = new Date("2026-10-14T00:00:00Z");
const base: Row = {
  id: "r1",
  values: { qty: 2, price: 10, total: 20, ratio: 5, note: "a" },
  createdAt: now.toISOString(),
  updatedAt: now.toISOString(),
  rev: 3,
};

describe("displayRow", () => {
  it("returns the confirmed row itself when nothing is pending", () => {
    expect(displayRow(base, [], undefined, context, now)).toBe(base);
  });

  it("applies pending edits in order and recomputes dependent formulas in the row", () => {
    const row = displayRow(
      base,
      [
        { opId: 1, op: "update", rowId: "r1", values: { qty: 3 } },
        { opId: 2, op: "update", rowId: "r1", values: { qty: 4, note: "b" } },
      ],
      undefined,
      context,
      now,
    );
    expect(row.values).toMatchObject({ qty: 4, note: "b", total: 40, ratio: 2.5 });
    expect(row.saving).toBe(true);
    expect(base.values.qty).toBe(2); // the confirmed row is never mutated
  });

  it("shows formula errors optimistically", () => {
    const row = displayRow(base, [{ opId: 1, op: "update", rowId: "r1", values: { qty: 0 } }], undefined, context, now);
    expect(row.values.ratio).toBeNull();
    expect(row.errors?.ratio).toBe("#DIV/0! Division by zero");
  });

  it("only recomputes formulas that depend on the edit", () => {
    const row = displayRow({ ...base, values: { ...base.values, total: 999 } }, [{ opId: 1, op: "update", rowId: "r1", values: { note: "x" } }], undefined, context, now);
    expect(row.values.total).toBe(999);
  });

  it("carries save errors for failed cells", () => {
    expect(displayRow(base, [], { qty: "Must be ≥ 0" }, context, now).saveErrors).toEqual({ qty: "Must be ≥ 0" });
  });
});

describe("displayRow deletes", () => {
  it("marks a row being deleted", () => {
    expect(displayRow(base, [{ opId: 1, op: "delete", rowId: "r1", values: {} }], undefined, context, now).deleting).toBe(true);
  });
});
