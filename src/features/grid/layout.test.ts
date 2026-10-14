import { describe, expect, it } from "vitest";
import type { Field } from "@/lib/domain/field";
import { gridColumns, moveField, setColumnWidth, setFieldHidden } from "./layout";

const fields: Field[] = [
  { id: "a", name: "A", type: "text" },
  { id: "b", name: "B", type: "checkbox" },
  { id: "c", name: "C", type: "number", precision: 0 },
  { id: "d", name: "D", type: "text" },
];

describe("gridColumns", () => {
  it("puts the primary field first, follows fieldOrder, appends new fields and skips hidden ones", () => {
    const columns = gridColumns(fields, "c", { fieldOrder: ["b", "a", "c"], hiddenFieldIds: ["a"], columnWidths: { b: 300 } });
    expect(columns.map((column) => column.field.id)).toEqual(["c", "b", "d"]);
    expect(columns.map((column) => column.width)).toEqual([220, 300, 180]);
  });

  it("never hides the primary field and ignores unknown ids", () => {
    const columns = gridColumns(fields, "a", { fieldOrder: ["gone", "d"], hiddenFieldIds: ["a"], columnWidths: {} });
    expect(columns.map((column) => column.field.id)).toEqual(["a", "d", "b", "c"]);
  });
});

describe("layout changes", () => {
  const layout = { fieldOrder: ["a", "b", "c"], hiddenFieldIds: ["c"], columnWidths: {} };

  it("moves a field among visible columns, skipping hidden ones and keeping the primary first", () => {
    // visible non-primary order is b, d (c is hidden, a is primary)
    expect(moveField(fields, "a", layout, "d", -1).fieldOrder).toEqual(["a", "d", "c", "b"]);
    expect(moveField(fields, "a", layout, "b", -1)).toBe(layout); // already first
    expect(moveField(fields, "a", layout, "a", 1)).toBe(layout); // the primary doesn't move
  });

  it("hides and shows fields", () => {
    expect(setFieldHidden(layout, "b", true).hiddenFieldIds).toEqual(["c", "b"]);
    expect(setFieldHidden(layout, "c", false).hiddenFieldIds).toEqual([]);
  });

  it("clamps column widths", () => {
    expect(setColumnWidth(layout, "b", 10).columnWidths.b).toBe(60);
    expect(setColumnWidth(layout, "b", 5000).columnWidths.b).toBe(800);
  });
});
