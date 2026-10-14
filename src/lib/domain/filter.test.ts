import { describe, expect, it } from "vitest";
import type { Field } from "./field";
import {
  changeOperator,
  defaultConditionFor,
  emptyCondition,
  filterConditionSchema,
  filterGroupSchema,
  isConditionComplete,
  type FilterGroup,
} from "./filter";
import { viewConfigSchemaFor } from "./view";

const fields: Field[] = [
  { id: "name", name: "Name", type: "text" },
  { id: "qty", name: "Qty", type: "number", precision: 0 },
  { id: "due", name: "Due", type: "date", includeTime: false },
  { id: "status", name: "Status", type: "singleSelect", options: [{ id: "o1", label: "Done", color: "#00ff00" }] },
  { id: "tags", name: "Tags", type: "multiSelect", options: [] },
  { id: "total", name: "Total", type: "formula", expression: "{qty} * 2", resultType: "number" },
];

const filterWith = (conditions: FilterGroup["conditions"]): FilterGroup => ({ conjunction: "and", conditions, groups: [] });

describe("filter conditions", () => {
  it("default condition depends on the field type", () => {
    expect(defaultConditionFor(fields[0])).toEqual({ fieldId: "name", operator: "contains", value: "" });
    expect(defaultConditionFor(fields[1])).toEqual({ fieldId: "qty", operator: "eq", value: null });
    expect(defaultConditionFor(fields[2])).toEqual({ fieldId: "due", operator: "is", value: "" });
    expect(defaultConditionFor(fields[3])).toEqual({ fieldId: "status", operator: "isAnyOf", value: [] });
    // formulas filter by their result type
    expect(defaultConditionFor(fields[5]).operator).toBe("eq");
  });

  it("changing the operator keeps a value of the same shape and drops the rest", () => {
    expect(changeOperator({ fieldId: "name", operator: "contains", value: "ab" }, "is")).toEqual({ fieldId: "name", operator: "is", value: "ab" });
    expect(changeOperator({ fieldId: "qty", operator: "eq", value: 5 }, "gt")).toEqual({ fieldId: "qty", operator: "gt", value: 5 });
    expect(changeOperator({ fieldId: "qty", operator: "eq", value: 5 }, "between")).toEqual({ fieldId: "qty", operator: "between", value: { min: null, max: null } });
    expect(changeOperator({ fieldId: "due", operator: "is", value: "2026-01-01" }, "isToday")).toEqual({ fieldId: "due", operator: "isToday" });
    expect(changeOperator({ fieldId: "due", operator: "isToday" }, "before")).toEqual({ fieldId: "due", operator: "before", value: "" });
    // Same shape, but not a valid value for the new operator.
    expect(changeOperator({ fieldId: "due", operator: "before", value: "2026-01-01" }, "withinLastDays")).toEqual({ fieldId: "due", operator: "withinLastDays", value: null });
  });

  it("an operator without a value produces no value key", () => {
    expect(emptyCondition("due", "isToday")).toEqual({ fieldId: "due", operator: "isToday" });
  });

  it("strips keys that don't belong to the operator", () => {
    const parsed = filterConditionSchema.parse({ fieldId: "due", operator: "isToday", value: "2026-01-01" });
    expect(parsed).toEqual({ fieldId: "due", operator: "isToday" });
  });

  it("treats empty values as incomplete", () => {
    expect(isConditionComplete(emptyCondition("qty", "eq"))).toBe(false);
    expect(isConditionComplete(emptyCondition("qty", "between"))).toBe(false);
    expect(isConditionComplete({ fieldId: "qty", operator: "between", value: { min: 1, max: 2 } })).toBe(true);
    expect(isConditionComplete({ fieldId: "qty", operator: "eq", value: 0 })).toBe(true);
    expect(isConditionComplete(emptyCondition("due", "isToday"))).toBe(true);
  });

  it("rejects between with min > max", () => {
    const result = filterConditionSchema.safeParse({ fieldId: "qty", operator: "between", value: { min: 5, max: 1 } });
    expect(result.error?.issues[0].path).toEqual(["value", "max"]);
  });

  it("limits nesting to two levels by shape", () => {
    const nested = { conjunction: "and", conditions: [], groups: [{ conjunction: "or", conditions: [], groups: [] }] };
    // the extra `groups` key on a subgroup is stripped, so a third level can't be expressed
    expect(filterGroupSchema.parse(nested).groups[0]).toEqual({ conjunction: "or", conditions: [] });
  });
});

describe("viewConfigSchemaFor", () => {
  const schema = viewConfigSchemaFor(fields);
  const config = (filter: FilterGroup, sorts: { fieldId: string; direction: "asc" | "desc" }[] = []) => ({
    filter,
    sorts,
    hiddenFieldIds: [],
  });
  const issuePaths = (value: unknown) => schema.safeParse(value).error?.issues.map((issue) => issue.path) ?? [];

  it("accepts a valid config", () => {
    const filter: FilterGroup = {
      conjunction: "or",
      conditions: [{ fieldId: "name", operator: "contains", value: "a" }],
      groups: [{ conjunction: "and", conditions: [{ fieldId: "due", operator: "isToday" }] }],
    };
    expect(schema.safeParse(config(filter, [{ fieldId: "qty", direction: "desc" }])).success).toBe(true);
  });

  it("rejects an operator that doesn't fit the field type", () => {
    expect(issuePaths(config(filterWith([{ fieldId: "name", operator: "gt", value: 1 }])))).toEqual([
      ["filter", "conditions", 0, "operator"],
    ]);
  });

  it("rejects conditions on deleted fields with a path inside the subgroup", () => {
    const filter: FilterGroup = {
      conjunction: "and",
      conditions: [],
      groups: [{ conjunction: "and", conditions: [{ fieldId: "gone", operator: "isEmpty" }] }],
    };
    expect(issuePaths(config(filter))).toEqual([["filter", "groups", 0, "conditions", 0, "fieldId"]]);
  });

  it("rejects invalid dates and unknown select options", () => {
    expect(issuePaths(config(filterWith([{ fieldId: "due", operator: "is", value: "2026-13-01" }])))).toEqual([
      ["filter", "conditions", 0, "value"],
    ]);
    expect(issuePaths(config(filterWith([{ fieldId: "status", operator: "isAnyOf", value: ["nope"] }])))).toEqual([
      ["filter", "conditions", 0, "value"],
    ]);
  });

  it("rejects duplicate and unsortable sorts", () => {
    const duplicate = [
      { fieldId: "qty", direction: "asc" as const },
      { fieldId: "qty", direction: "desc" as const },
    ];
    expect(schema.safeParse(config(filterWith([]), duplicate)).success).toBe(false);
    expect(issuePaths(config(filterWith([]), [{ fieldId: "tags", direction: "asc" }]))).toEqual([["sorts", 0, "fieldId"]]);
  });
});
