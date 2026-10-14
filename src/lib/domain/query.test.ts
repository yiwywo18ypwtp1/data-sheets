import { describe, expect, it } from "vitest";
import type { FilterGroup } from "./filter";
import { decodeFilterParam, decodeSortParam, encodeFilterParam, encodeSortParam } from "./query";

describe("filter query param", () => {
  const filter: FilterGroup = {
    conjunction: "or",
    conditions: [{ fieldId: "fld_notes", operator: "contains", value: "Київ ✓ + / =" }],
    groups: [
      {
        conjunction: "and",
        conditions: [
          { fieldId: "fld_qty", operator: "between", value: { min: 1, max: 5 } },
          { fieldId: "fld_due", operator: "isToday" },
        ],
      },
    ],
  };

  it("round-trips, including non-ASCII text, with URL-safe characters only", () => {
    const encoded = encodeFilterParam(filter);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeFilterParam(encoded)).toEqual(filter);
  });

  it.each(["garbage!", "Z2FyYmFnZQ", encodeFilterParam({ conjunction: "xor" } as unknown as FilterGroup), "%%%"])(
    "rejects %j",
    (encoded) => {
      expect(decodeFilterParam(encoded)).toBeNull();
    },
  );
});

describe("sort query param", () => {
  it("round-trips", () => {
    const sorts = [
      { fieldId: "fld_a", direction: "asc" as const },
      { fieldId: "fld_b", direction: "desc" as const },
    ];
    expect(encodeSortParam(sorts)).toBe("fld_a:asc,fld_b:desc");
    expect(decodeSortParam(encodeSortParam(sorts))).toEqual(sorts);
    expect(decodeSortParam("")).toEqual([]);
  });

  it.each(["fld_a", "fld_a:up", "fld_a:asc,fld_a:desc", "bad id:asc"])("rejects %j", (encoded) => {
    expect(decodeSortParam(encoded)).toBeNull();
  });
});
