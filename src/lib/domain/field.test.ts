import { describe, expect, it } from "vitest";
import { fieldSchema } from "./field";

describe("fieldSchema", () => {
  it("accepts every field type from the domain model", () => {
    const fields = [
      { id: "f1", name: "Title", type: "text", maxLength: 255 },
      { id: "f2", name: "Qty", type: "number", precision: 0, min: 0 },
      { id: "f3", name: "Price", type: "currency", currency: "USD" },
      { id: "f4", name: "Start", type: "date", includeTime: true, timeZone: "Europe/Berlin" },
      { id: "f5", name: "Done", type: "checkbox" },
      { id: "f6", name: "Status", type: "singleSelect", options: [{ id: "o1", label: "Todo", color: "#ff0000" }] },
      { id: "f7", name: "Tags", type: "multiSelect", options: [] },
      { id: "f8", name: "Email", type: "email" },
      { id: "f9", name: "Site", type: "url" },
      { id: "f10", name: "Customer", type: "link", targetTableId: "t2", multiple: false },
      { id: "f11", name: "Customer name", type: "lookup", linkFieldId: "f10", targetFieldId: "f99" },
      { id: "f12", name: "Total", type: "formula", expression: "{f2} * {f3}", resultType: "number" },
    ];
    for (const field of fields) expect(fieldSchema.safeParse(field).success, field.type).toBe(true);
  });

  it("rejects braces in names because formulas use {Name} references", () => {
    expect(fieldSchema.safeParse({ id: "f1", name: "a{b}", type: "checkbox" }).success).toBe(false);
  });

  it("trims names", () => {
    expect(fieldSchema.parse({ id: "f1", name: "  Done  ", type: "checkbox" }).name).toBe("Done");
  });

  it("rejects min greater than max with an issue on max", () => {
    const result = fieldSchema.safeParse({ id: "f1", name: "N", type: "number", precision: 2, min: 10, max: 1 });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].path).toEqual(["max"]);
  });

  it("rejects precision outside 0..4", () => {
    expect(fieldSchema.safeParse({ id: "f1", name: "N", type: "number", precision: 5 }).success).toBe(false);
  });

  it("rejects duplicate select labels case-insensitively", () => {
    const result = fieldSchema.safeParse({
      id: "f1",
      name: "S",
      type: "singleSelect",
      options: [
        { id: "o1", label: "Done", color: "#000000" },
        { id: "o2", label: "done ", color: "#000000" },
      ],
    });
    expect(result.error?.issues[0].path).toEqual(["options", 1, "label"]);
  });

  it("validates time zones and currencies", () => {
    expect(fieldSchema.safeParse({ id: "f1", name: "D", type: "date", includeTime: true, timeZone: "UTC" }).success).toBe(true);
    expect(fieldSchema.safeParse({ id: "f1", name: "D", type: "date", includeTime: true, timeZone: "Mars/Base" }).success).toBe(false);
    expect(fieldSchema.safeParse({ id: "f1", name: "C", type: "currency", currency: "XXZ" }).success).toBe(false);
  });

  it("rejects ids that would be unsafe in formula references or JSON paths", () => {
    expect(fieldSchema.safeParse({ id: "f.1", name: "D", type: "checkbox" }).success).toBe(false);
  });
});
