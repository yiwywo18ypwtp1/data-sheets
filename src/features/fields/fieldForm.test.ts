import { describe, expect, it } from "vitest";
import { fieldSchema, type Field, type FieldType } from "@/lib/domain/field";
import type { Row } from "@/lib/domain/row";
import { FIELD_TYPE_LABELS, fieldDefaults, fieldFormSchema, FormulaSyntaxError, previewFormula, toFormValues } from "./fieldForm";

const fields: Field[] = [
  { id: "fld_qty", name: "Qty", type: "number", precision: 0 },
  { id: "fld_price", name: "Price", type: "currency", currency: "USD" },
  { id: "fld_total", name: "Total", type: "formula", expression: "{fld_qty} * {fld_price}", resultType: "number" },
];
const row = (id: string, values: Row["values"]): Row => ({ id, values, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", rev: 1 });
const context = { tableIds: ["tbl_other"], linkFieldIds: ["fld_link"] };

describe("fieldDefaults", () => {
  it.each(Object.keys(FIELD_TYPE_LABELS) as FieldType[])("gives a %s field only its own settings", (type) => {
    const field = fieldDefaults(type, { id: "fld_new", name: "New" }, context);
    expect(field).toMatchObject({ id: "fld_new", name: "New", type });
    // Every default is a valid field once the user fills what only they can (formula, lookup target).
    const filled = { ...field, ...(type === "formula" ? { expression: "1" } : {}), ...(type === "lookup" ? { targetFieldId: "fld_x" } : {}) };
    expect(fieldSchema.safeParse(filled).success).toBe(true);
  });
});

describe("fieldFormSchema", () => {
  it("rejects a name another field already has, ignoring case", () => {
    const result = fieldFormSchema(fields).safeParse({ id: "fld_new", name: " qty ", type: "text" });
    expect(result.error?.issues[0]).toMatchObject({ path: ["name"], message: "A field with this name already exists" });
  });
});

describe("toFormValues", () => {
  it("shows formulas with field names", () => {
    expect(toFormValues(fields[2], fields)).toMatchObject({ expression: "{Qty} * {Price}" });
  });
});

describe("previewFormula", () => {
  const rows = [row("r1", { fld_qty: 2, fld_price: 1.5 }), row("r2", { fld_qty: 1 })];

  it("evaluates the typed formula on the given rows", () => {
    expect(previewFormula("{Qty} * {Price} + 1", fields, rows, { now: new Date() })).toEqual([
      { rowId: "r1", value: 4 },
      { rowId: "r2", value: 1 },
    ]);
  });

  it("returns runtime errors per row", () => {
    expect(previewFormula("{Qty} / ({Qty} - 1)", fields, rows, { now: new Date() })[1]).toEqual({ rowId: "r2", error: "#DIV/0! Division by zero" });
  });

  it("throws syntax errors with their position", () => {
    expect(() => previewFormula("{Qty} * {Prise}", fields, rows, { now: new Date() })).toThrow(FormulaSyntaxError);
  });
});
