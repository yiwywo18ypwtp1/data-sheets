import { describe, expect, it } from "vitest";
import type { CellValue } from "@/lib/domain/cell";
import type { Field } from "@/lib/domain/field";
import { createConverter, optionsFromValues, unsupportedConversion, valueAsText } from "./convert";

const uk = { locale: "uk-UA", timeZone: "Europe/Kyiv" };
const noLabels = () => undefined;
const text: Field = { id: "f", name: "F", type: "text" };
const number: Field = { id: "f", name: "F", type: "number", precision: 2 };
const status: Field = { id: "f", name: "F", type: "singleSelect", options: [{ id: "o1", label: "Done", color: "#000000" }, { id: "o2", label: "Open", color: "#000000" }] };
const tags: Field = { id: "f", name: "F", type: "multiSelect", options: status.type === "singleSelect" ? status.options : [] };
const convert = (from: Field, to: Field, value: CellValue) => createConverter(from, to, uk, noLabels)(value);

describe("createConverter", () => {
  it("text → number: numbers in the user's format convert, the rest is reported", () => {
    expect(convert(text, number, "1 234,567")).toEqual({ ok: true, value: 1234.57 });
    expect(convert(text, number, "n/a")).toEqual({ ok: false, error: '"n/a" is not a number' });
    expect(convert(text, number, null)).toEqual({ ok: true, value: null });
  });

  it("number → text → number round-trips", () => {
    const back = convert(text, number, (convert(number, text, 1234.5) as { value: CellValue }).value);
    expect(back).toEqual({ ok: true, value: 1234.5 });
  });

  it("keeps numbers as numbers when the precision changes (no locale text in between)", () => {
    expect(convert(number, { ...number, precision: 0 }, 1.234)).toEqual({ ok: true, value: 1 });
    expect(convert(number, { id: "f", name: "F", type: "currency", currency: "USD" }, 1.234)).toEqual({ ok: true, value: 1.234 });
    expect(convert(number, { ...number, max: 10 }, 99)).toMatchObject({ ok: false });
  });

  it("selects convert by label; multiple → single keeps the first", () => {
    expect(convert(status, text, "o2")).toEqual({ ok: true, value: "Open" });
    expect(convert(text, status, "done")).toEqual({ ok: true, value: "o1" });
    expect(convert(tags, status, ["o2", "o1"])).toEqual({ ok: true, value: "o2" });
    expect(convert(status, tags, "o1")).toEqual({ ok: true, value: ["o1"] });
  });

  it("date ↔ date-time in the field's zone", () => {
    const date: Field = { id: "f", name: "F", type: "date", includeTime: false };
    const dateTime: Field = { id: "f", name: "F", type: "date", includeTime: true, timeZone: "Europe/Kyiv" };
    expect(convert(date, dateTime, "2026-03-12")).toEqual({ ok: true, value: "2026-03-11T22:00:00.000Z" });
    expect(convert(dateTime, date, "2026-03-11T22:30:00.000Z")).toEqual({ ok: true, value: "2026-03-12" });
  });

  it("checkbox ↔ text and number → checkbox", () => {
    const checkbox: Field = { id: "f", name: "F", type: "checkbox" };
    expect(convert(checkbox, text, true)).toEqual({ ok: true, value: "true" });
    expect(convert(text, checkbox, "так")).toEqual({ ok: true, value: true });
    expect(convert(number, checkbox, 0)).toEqual({ ok: true, value: false });
  });

  it("link → text uses the linked records' names", () => {
    const link: Field = { id: "f", name: "F", type: "link", targetTableId: "t", multiple: true };
    expect(createConverter(link, text, uk, (id) => ({ r1: "Ada", r2: "Bob" })[id])(["r1", "r2"])).toEqual({ ok: true, value: "Ada, Bob" });
    expect(unsupportedConversion(text, link)).toMatch(/isn't supported/);
  });
});

describe("optionsFromValues", () => {
  it("adds every new label once, after the existing options", () => {
    const options = optionsFromValues([{ id: "o1", label: "Done", color: "#000000" }], ["done", "Open", " open ", "Later, Soon"], true, (i) => `opt_${i}`);
    expect(options.map((option) => option.label)).toEqual(["Done", "Open", "Later", "Soon"]);
  });

  it("refuses more labels than a select can have", () => {
    expect(() => optionsFromValues([], Array.from({ length: 201 }, (_, i) => `v${i}`), false, (i) => `opt_${i}`)).toThrow(/at most 200/);
  });
});

describe("valueAsText", () => {
  it("shows what a person would type", () => {
    expect(valueAsText(tags, ["o1", "o2"], noLabels)).toBe("Done, Open");
    expect(valueAsText(number, 12.5, noLabels)).toBe("12.5");
  });
});
