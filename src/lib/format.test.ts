import { describe, expect, it } from "vitest";
import type { Field } from "./domain/field";
import { createCoercer } from "./coerce/coerce";
import { createCellFormatter, toEditText, type FormatContext } from "./format";

const uk: FormatContext = { locale: "uk-UA", timeZone: "Europe/Kyiv", labelOf: (id) => ({ row_1: "Ada" })[id] };
const us: FormatContext = { locale: "en-US", timeZone: "America/Los_Angeles", labelOf: () => undefined };
const format = (field: Field, value: unknown, context = uk) => createCellFormatter(field, context)(value as never);

describe("createCellFormatter", () => {
  it("formats numbers and currency in the viewer's locale", () => {
    expect(format({ id: "f", name: "N", type: "number", precision: 2 }, 1234.5, us)).toBe("1,234.50");
    expect(format({ id: "f", name: "N", type: "number", precision: 2 }, 1234.5)).toBe("1 234,50");
    expect(format({ id: "f", name: "C", type: "currency", currency: "USD" }, 12, us)).toBe("$12.00");
  });

  it("never shifts date-only values, in any zone", () => {
    const field: Field = { id: "f", name: "D", type: "date", includeTime: false };
    expect(format(field, "2026-03-01", { ...us, timeZone: "Pacific/Auckland" })).toBe("Mar 1, 2026");
    expect(format(field, "2026-03-01", { ...us, timeZone: "America/Los_Angeles" })).toBe("Mar 1, 2026");
  });

  it("shows date-times in the field's zone, falling back to the viewer's", () => {
    const berlin: Field = { id: "f", name: "D", type: "date", includeTime: true, timeZone: "Europe/Berlin" };
    const viewer: Field = { id: "f", name: "D", type: "date", includeTime: true };
    expect(format(berlin, "2026-01-15T13:30:00.000Z", us)).toBe("Jan 15, 2026, 2:30 PM");
    expect(format(viewer, "2026-01-15T13:30:00.000Z", us)).toBe("Jan 15, 2026, 5:30 AM");
  });

  it("shows option labels, linked record labels and lookups", () => {
    const options = [
      { id: "o1", label: "Done", color: "#000000" },
      { id: "o2", label: "Late", color: "#000000" },
    ];
    expect(format({ id: "f", name: "M", type: "multiSelect", options }, ["o2", "o1"])).toBe("Late, Done");
    expect(format({ id: "f", name: "L", type: "link", targetTableId: "t", multiple: true }, ["row_1", "row_2"])).toBe("Ada, …");
    expect(format({ id: "f", name: "K", type: "lookup", linkFieldId: "l", targetFieldId: "t" }, ["12.5", "3"])).toBe("12.5, 3");
  });

  it("renders empty values as empty text", () => {
    expect(format({ id: "f", name: "T", type: "text" }, undefined)).toBe("");
    expect(format({ id: "f", name: "N", type: "number", precision: 0 }, null)).toBe("");
  });
});

describe("toEditText", () => {
  const roundTrip = (field: Field, value: unknown, context: FormatContext) => {
    const text = toEditText(field, value as never, context);
    const parsed = createCoercer(field, context)(text);
    return { text, value: parsed.ok ? parsed.value : parsed.error };
  };

  it.each([
    ["uk-UA", uk],
    ["en-US", us],
  ])("round-trips numbers, money and dates through the editor in %s", (_name, context) => {
    const number: Field = { id: "f", name: "N", type: "number", precision: 2 };
    const money: Field = { id: "f", name: "C", type: "currency", currency: "USD" };
    const date: Field = { id: "f", name: "D", type: "date", includeTime: false };
    const berlin: Field = { id: "f", name: "D", type: "date", includeTime: true, timeZone: "Europe/Berlin" };
    expect(roundTrip(number, 1234.5, context).value).toBe(1234.5);
    expect(roundTrip(money, 99.99, context).value).toBe(99.99);
    expect(roundTrip(date, "2026-03-01", context).value).toBe("2026-03-01");
    expect(roundTrip(berlin, "2026-10-25T00:30:00.000Z", context).value).toBe("2026-10-25T00:30:00.000Z");
  });

  it("uses numeric, locale-ordered dates and ungrouped numbers", () => {
    expect(toEditText({ id: "f", name: "D", type: "date", includeTime: false }, "2026-03-01", uk)).toBe("01.03.2026");
    expect(toEditText({ id: "f", name: "D", type: "date", includeTime: false }, "2026-03-01", us)).toBe("03/01/2026");
    expect(toEditText({ id: "f", name: "N", type: "number", precision: 2 }, 1234.5, uk)).toBe("1234,5");
  });
});
