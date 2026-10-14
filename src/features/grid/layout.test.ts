import { describe, expect, it } from "vitest";
import type { Field } from "@/lib/domain/field";
import { gridColumns } from "./layout";

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
