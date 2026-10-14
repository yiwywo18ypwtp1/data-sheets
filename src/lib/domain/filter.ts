import { z } from "zod";
import { dateOnlySchema } from "./cell";
import type { Field } from "./field";
import { idSchema } from "./ids";

/**
 * Filter conditions are a discriminated union on `operator`: each operator has
 * exactly one value shape, so switching operators can't leave stale keys behind.
 *
 * A condition may be *incomplete* (empty value) while the user is still typing.
 * Incomplete conditions are valid and simply ignored when filtering, like in Airtable,
 * so a half-filled form never blocks the grid. See `isConditionComplete`.
 */
const fieldId = idSchema;

const textValue = z.object({ fieldId, operator: z.enum(["contains", "is"]), value: z.string() });
const numberValue = z.object({
  fieldId,
  operator: z.enum(["eq", "neq", "lt", "gt"]),
  value: z.number().nullable(),
});
const between = z.object({
  fieldId,
  operator: z.literal("between"),
  value: z.object({ min: z.number().nullable(), max: z.number().nullable() }),
});
const dateCompare = z.object({
  fieldId,
  operator: z.enum(["before", "after"]),
  value: z.union([z.literal(""), dateOnlySchema]),
});
const withinLastDays = z.object({
  fieldId,
  operator: z.literal("withinLastDays"),
  value: z.number().int().min(1).max(3650).nullable(),
});
const idList = z.object({
  fieldId,
  operator: z.enum(["isAnyOf", "isNoneOf", "hasAnyOf"]),
  value: z.array(z.string()),
});
const noValue = z.object({
  fieldId,
  operator: z.enum(["isEmpty", "isToday", "isChecked", "isNotChecked"]),
});

export const filterConditionSchema = z
  .discriminatedUnion("operator", [textValue, numberValue, between, dateCompare, withinLastDays, idList, noValue])
  .superRefine((condition, ctx) => {
    if (condition.operator !== "between") return;
    const { min, max } = condition.value;
    if (min !== null && max !== null && min > max) {
      ctx.addIssue({ code: "custom", path: ["value", "max"], message: "Max must be greater than or equal to min" });
    }
  });

export type FilterCondition = z.infer<typeof filterConditionSchema>;
export type FilterOperator = FilterCondition["operator"];

export const conjunctionSchema = z.enum(["and", "or"]);

/**
 * At most two levels: the root group holds conditions and nested groups,
 * nested groups hold only conditions. Expressing the depth limit in the shape
 * (instead of a recursive type with a depth check) keeps the RHF field paths simple.
 */
export const filterSubgroupSchema = z.object({
  conjunction: conjunctionSchema,
  conditions: z.array(filterConditionSchema).max(50),
});

export const filterGroupSchema = z.object({
  conjunction: conjunctionSchema,
  conditions: z.array(filterConditionSchema).max(50),
  groups: z.array(filterSubgroupSchema).max(20),
});

export type FilterSubgroup = z.infer<typeof filterSubgroupSchema>;
export type FilterGroup = z.infer<typeof filterGroupSchema>;

export const EMPTY_FILTER: FilterGroup = { conjunction: "and", conditions: [], groups: [] };

/** What a field filters as. Formulas filter by their result type; lookups filter as text. */
export type FilterKind = "text" | "number" | "date" | "checkbox" | "select" | "link";

export function filterKindOf(field: Field): FilterKind {
  switch (field.type) {
    case "text":
    case "email":
    case "url":
    case "lookup":
      return "text";
    case "number":
    case "currency":
      return "number";
    case "date":
      return "date";
    case "checkbox":
      return "checkbox";
    case "singleSelect":
    case "multiSelect":
      return "select";
    case "link":
      return "link";
    case "formula":
      return field.resultType;
  }
}

/** Date `is` reuses the text `is` member: same shape (a string), the date format is checked per field. */
export const OPERATORS_BY_KIND: Record<FilterKind, readonly FilterOperator[]> = {
  text: ["contains", "is", "isEmpty"],
  number: ["eq", "neq", "lt", "gt", "between"],
  date: ["is", "before", "after", "withinLastDays", "isToday"],
  checkbox: ["isChecked", "isNotChecked"],
  select: ["isAnyOf", "isNoneOf"],
  link: ["hasAnyOf"],
};

/** Builds a fresh condition with the operator's empty value. Used when the field or operator changes. */
export function emptyCondition(fieldId: string, operator: FilterOperator): FilterCondition {
  switch (operator) {
    case "contains":
    case "is":
    case "before":
    case "after":
      return { fieldId, operator, value: "" };
    case "eq":
    case "neq":
    case "lt":
    case "gt":
    case "withinLastDays":
      return { fieldId, operator, value: null };
    case "between":
      return { fieldId, operator, value: { min: null, max: null } };
    case "isAnyOf":
    case "isNoneOf":
    case "hasAnyOf":
      return { fieldId, operator, value: [] };
    case "isEmpty":
    case "isToday":
    case "isChecked":
    case "isNotChecked":
      return { fieldId, operator };
  }
}

/**
 * A condition with another operator. The value is kept when it has the same shape
 * ("contains" → "is" keeps the text, "=" → ">" keeps the number) and reset otherwise,
 * so no key from the old operator survives.
 */
export function changeOperator(condition: FilterCondition, operator: FilterOperator): FilterCondition {
  const next = emptyCondition(condition.fieldId, operator);
  if (!("value" in next) || !("value" in condition)) return next;
  const shape = (value: unknown) => (Array.isArray(value) ? "array" : value === null ? "number" : typeof value);
  const kept = { ...next, value: condition.value } as FilterCondition;
  return shape(next.value) === shape(condition.value) && filterConditionSchema.safeParse(kept).success ? kept : next;
}

export function defaultConditionFor(field: Field): FilterCondition {
  return emptyCondition(field.id, OPERATORS_BY_KIND[filterKindOf(field)][0]);
}

export function isConditionComplete(condition: FilterCondition): boolean {
  if (!("value" in condition)) return true;
  const { value } = condition;
  if (value === null) return false;
  if (typeof value === "string") return value !== "";
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return value.min !== null && value.max !== null;
  return true;
}

const RELATIVE_DATE_OPERATORS = new Set<FilterOperator>(["isToday", "withinLastDays"]);

/** Whether a filter's result depends on "today", i.e. on the clock and the time zone. */
export function usesRelativeDates(filter: FilterGroup): boolean {
  const conditions = [...filter.conditions, ...filter.groups.flatMap((group) => group.conditions)];
  return conditions.some((condition) => RELATIVE_DATE_OPERATORS.has(condition.operator) && isConditionComplete(condition));
}

type Issue = { path: (string | number)[]; message: string };
type ConditionIssue = { key: "fieldId" | "operator" | "value"; message: string };

function conditionIssue(condition: FilterCondition, fieldsById: Map<string, Field>): ConditionIssue | null {
  const field = fieldsById.get(condition.fieldId);
  if (!field) return { key: "fieldId", message: "Field no longer exists" };

  const kind = filterKindOf(field);
  if (!OPERATORS_BY_KIND[kind].includes(condition.operator)) {
    return { key: "operator", message: "Operator is not supported for this field type" };
  }
  if (kind === "date" && condition.operator === "is" && condition.value !== "") {
    if (!dateOnlySchema.safeParse(condition.value).success) return { key: "value", message: "Invalid date" };
  }
  if (kind === "select" && "value" in condition && Array.isArray(condition.value)) {
    const options = field.type === "singleSelect" || field.type === "multiSelect" ? field.options : [];
    if (condition.value.some((id) => !options.some((option) => option.id === id))) {
      return { key: "value", message: "Unknown option" };
    }
  }
  return null;
}

/**
 * Checks a structurally valid filter against the table's current fields:
 * the field exists, the operator fits its type, and the value fits the field.
 * Returned paths are relative to the filter group, so they map onto RHF field names.
 */
export function filterFieldIssues(filter: FilterGroup, fields: Field[]): Issue[] {
  const fieldsById = new Map(fields.map((field) => [field.id, field]));
  const issues: Issue[] = [];
  const check = (condition: FilterCondition, path: (string | number)[]) => {
    const issue = conditionIssue(condition, fieldsById);
    if (issue) issues.push({ path: [...path, issue.key], message: issue.message });
  };
  filter.conditions.forEach((condition, i) => check(condition, ["conditions", i]));
  filter.groups.forEach((group, g) =>
    group.conditions.forEach((condition, i) => check(condition, ["groups", g, "conditions", i])),
  );
  return issues;
}
