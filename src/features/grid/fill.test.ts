import { describe, expect, it } from "vitest";
import type { Field } from "@/lib/domain/field";
import { fillSeries } from "./fill";

const number: Field = { id: "n", name: "N", type: "number", precision: 2 };
const date: Field = { id: "d", name: "D", type: "date", includeTime: false };
const dateTime: Field = { id: "t", name: "T", type: "date", includeTime: true };
const text: Field = { id: "x", name: "X", type: "text" };

describe("fillSeries", () => {
  it("copies a single value", () => {
    expect(fillSeries(number, [5], 3)).toEqual([5, 5, 5]);
    expect(fillSeries(text, ["a"], 2)).toEqual(["a", "a"]);
  });

  it("continues a number progression, rounded to the field's precision", () => {
    expect(fillSeries(number, [1, 2], 3)).toEqual([3, 4, 5]);
    expect(fillSeries(number, [0.1, 0.2, 0.3], 2)).toEqual([0.4, 0.5]);
    expect(fillSeries(number, [10, 7], 2)).toEqual([4, 1]);
  });

  it("continues date and date-time progressions, across DST and month ends", () => {
    expect(fillSeries(date, ["2026-03-27", "2026-03-29"], 2)).toEqual(["2026-03-31", "2026-04-02"]);
    expect(fillSeries(dateTime, ["2026-01-01T09:00:00.000Z", "2026-01-01T10:30:00.000Z"], 1)).toEqual(["2026-01-01T12:00:00.000Z"]);
  });

  it("repeats a pattern without a constant step, and anything with gaps", () => {
    expect(fillSeries(number, [1, 2, 4], 4)).toEqual([1, 2, 4, 1]);
    expect(fillSeries(number, [1, null], 2)).toEqual([1, null]);
    expect(fillSeries(text, ["a", "b"], 3)).toEqual(["a", "b", "a"]);
  });
});
