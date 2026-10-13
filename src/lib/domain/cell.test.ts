import { describe, expect, it } from "vitest";
import { cellValueSchemaFor } from "./cell";
import type { Field } from "./field";

const valid = (field: Field, value: unknown) => cellValueSchemaFor(field).safeParse(value).success;

describe("cellValueSchemaFor", () => {
  it("allows null (empty) for every writable field", () => {
    expect(valid({ id: "f", name: "T", type: "text" }, null)).toBe(true);
    expect(valid({ id: "f", name: "C", type: "checkbox" }, null)).toBe(true);
  });

  it("enforces number precision and bounds", () => {
    const field: Field = { id: "f", name: "N", type: "number", precision: 2, min: 0, max: 100 };
    expect(valid(field, 12.34)).toBe(true);
    expect(valid(field, 12.345)).toBe(false);
    expect(valid(field, -1)).toBe(false);
    expect(valid(field, 101)).toBe(false);
    expect(valid(field, Number.NaN)).toBe(false);
  });

  it("stores dates as YYYY-MM-DD or UTC instants depending on includeTime", () => {
    const dateOnly: Field = { id: "f", name: "D", type: "date", includeTime: false };
    const dateTime: Field = { id: "f", name: "D", type: "date", includeTime: true };
    expect(valid(dateOnly, "2026-03-29")).toBe(true);
    expect(valid(dateOnly, "2026-02-30")).toBe(false);
    expect(valid(dateOnly, "2026-03-29T00:00:00.000Z")).toBe(false);
    expect(valid(dateTime, "2026-03-29T00:30:00.000Z")).toBe(true);
    expect(valid(dateTime, "2026-03-29T02:30:00+02:00")).toBe(false);
  });

  it("accepts only known select options", () => {
    const options = [{ id: "o1", label: "A", color: "#000000" }];
    expect(valid({ id: "f", name: "S", type: "singleSelect", options }, "o1")).toBe(true);
    expect(valid({ id: "f", name: "S", type: "singleSelect", options }, "o2")).toBe(false);
    expect(valid({ id: "f", name: "M", type: "multiSelect", options }, ["o1", "o1"])).toBe(false);
  });

  it("rejects non-http urls", () => {
    const field: Field = { id: "f", name: "U", type: "url" };
    expect(valid(field, "https://example.com")).toBe(true);
    expect(valid(field, "javascript:alert(1)")).toBe(false);
  });

  it("limits single links to one record", () => {
    const field: Field = { id: "f", name: "L", type: "link", targetTableId: "t", multiple: false };
    expect(valid(field, ["r1"])).toBe(true);
    expect(valid(field, ["r1", "r2"])).toBe(false);
  });

  it("never accepts writes to computed fields", () => {
    const field: Field = { id: "f", name: "F", type: "formula", expression: "1", resultType: "number" };
    expect(valid(field, 1)).toBe(false);
    expect(valid(field, null)).toBe(false);
  });
});
