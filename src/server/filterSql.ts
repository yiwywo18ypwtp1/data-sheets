import "server-only";
import type { Field } from "@/lib/domain/field";
import { filterKindOf, isConditionComplete, type FilterCondition, type FilterGroup } from "@/lib/domain/filter";
import { isSortable, type Sort } from "@/lib/domain/view";
import { wallTimeAt, wallTimeToInstant } from "@/lib/timezone";

/**
 * Compiles a view's filter and sorts into SQL over the `rows.cells` JSON column.
 * Every value, and every JSON path, is a bound parameter: nothing user-controlled
 * is concatenated into the SQL text.
 */

export type SqlFragment = { sql: string; params: unknown[] };

export type QueryContext = {
  now: Date;
  /** Used for "today" and day boundaries of date fields without their own time zone. */
  timeZone: string;
};

const path = (fieldId: string) => `$."${fieldId}"`;

/** The cell as SQLite sees it: a number, text, 0/1 for booleans, or JSON text for arrays. */
function cell(field: Field): SqlFragment {
  return { sql: "json_extract(cells, ?)", params: [path(field.id)] };
}

/** Lookups are arrays of texts; they filter like the joined text shown in the grid. */
function cellAsText(field: Field): SqlFragment {
  if (field.type === "lookup") {
    return { sql: "(SELECT group_concat(value, ', ') FROM json_each(cells, ?))", params: [path(field.id)] };
  }
  return cell(field);
}

function sql(strings: TemplateStringsArray, ...parts: (SqlFragment | unknown)[]): SqlFragment {
  let text = strings[0];
  const params: unknown[] = [];
  parts.forEach((part, i) => {
    if (part && typeof part === "object" && "sql" in part && "params" in part) {
      text += (part as SqlFragment).sql;
      params.push(...(part as SqlFragment).params);
    } else {
      text += "?";
      params.push(part);
    }
    text += strings[i + 1];
  });
  return { sql: text, params };
}

function concat(fragments: SqlFragment[], separator: string): SqlFragment {
  return { sql: fragments.map((fragment) => fragment.sql).join(separator), params: fragments.flatMap((f) => f.params) };
}

/** Joins boolean conditions; each is parenthesised so `a OR b` inside an AND group keeps its meaning. */
function combine(fragments: SqlFragment[], operator: "AND" | "OR"): SqlFragment {
  return concat(fragments.map((fragment) => ({ ...fragment, sql: `(${fragment.sql})` })), ` ${operator} `);
}

function placeholders(values: unknown[]): SqlFragment {
  return { sql: values.map(() => "?").join(", "), params: values };
}

const DAY_MS = 86_400_000;

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** First instant of a calendar day in a zone. A few zones skip midnight on DST days; then 01:00 is the start. */
function startOfDay(date: string, timeZone: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const wall = { year, month, day, hour: 0, minute: 0, second: 0 };
  const ms = wallTimeToInstant(wall, timeZone) ?? wallTimeToInstant({ ...wall, hour: 1 }, timeZone)!;
  return new Date(ms).toISOString();
}

function todayIn(context: QueryContext, timeZone: string): string {
  const { year, month, day } = wallTimeAt(context.now.getTime(), timeZone);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Date conditions become ranges of calendar days [from, to). Date-only values are
 * compared as `YYYY-MM-DD` text; date-time values (UTC ISO strings, which sort as text)
 * against the day boundaries in the field's time zone.
 */
function dateRange(field: Field, from: string | null, to: string | null, context: QueryContext): SqlFragment {
  const timeZone = (field.type === "date" && field.timeZone) || context.timeZone;
  const withTime = field.type === "date" && field.includeTime;
  // Formula dates may or may not carry a time; their calendar date (UTC) is compared.
  const value = field.type === "formula" ? sql`substr(${cell(field)}, 1, 10)` : cell(field);
  const bound = (date: string) => (withTime ? startOfDay(date, timeZone) : date);

  const parts: SqlFragment[] = [];
  if (from !== null) parts.push(sql`${value} >= ${bound(from)}`);
  if (to !== null) parts.push(sql`${value} < ${bound(to)}`);
  return combine(parts, "AND");
}

function conditionSql(condition: FilterCondition, field: Field, context: QueryContext): SqlFragment {
  const kind = filterKindOf(field);
  const value = cell(field);
  const timeZone = (field.type === "date" && field.timeZone) || context.timeZone;

  switch (condition.operator) {
    case "contains":
      return sql`instr(ulower(coalesce(${cellAsText(field)}, '')), ${condition.value.toLowerCase()}) > 0`;
    case "is":
      if (kind === "date") return dateRange(field, condition.value, addDays(condition.value, 1), context);
      return sql`ulower(${cellAsText(field)}) = ${condition.value.trim().toLowerCase()}`;
    case "isEmpty":
      return sql`coalesce(${cellAsText(field)}, '') = ''`;

    // `≠` keeps empty cells, like spreadsheets do: an empty Qty is "not 5".
    case "eq":
      return sql`${value} = ${condition.value}`;
    case "neq":
      return sql`${value} IS NULL OR ${value} != ${condition.value}`;
    case "lt":
      return sql`${value} < ${condition.value}`;
    case "gt":
      return sql`${value} > ${condition.value}`;
    case "between":
      return sql`${value} BETWEEN ${condition.value.min} AND ${condition.value.max}`;

    case "before":
      return dateRange(field, null, condition.value, context);
    case "after":
      return dateRange(field, addDays(condition.value, 1), null, context);
    case "isToday": {
      const today = todayIn(context, timeZone);
      return dateRange(field, today, addDays(today, 1), context);
    }
    case "withinLastDays": {
      // The last N days including today: N = 1 is just today.
      const today = todayIn(context, timeZone);
      return dateRange(field, addDays(today, 1 - condition.value!), addDays(today, 1), context);
    }

    case "isChecked":
      return sql`${value} = 1`;
    case "isNotChecked":
      return sql`coalesce(${value}, 0) = 0`;

    case "isAnyOf":
    case "isNoneOf":
    case "hasAnyOf": {
      const ids = placeholders(condition.value);
      const any =
        field.type === "singleSelect"
          ? sql`${value} IN (${ids})`
          : sql`EXISTS (SELECT 1 FROM json_each(cells, ${path(field.id)}) WHERE value IN (${ids}))`;
      return condition.operator === "isNoneOf" ? sql`NOT coalesce(${any}, 0)` : any;
    }
  }
}

/**
 * Incomplete conditions (still being typed) and conditions on fields that no
 * longer exist (deleted by someone else) are skipped instead of failing the query.
 */
export function compileFilter(filter: FilterGroup, fields: Field[], context: QueryContext): SqlFragment {
  const fieldsById = new Map(fields.map((field) => [field.id, field]));
  const conditions = (list: FilterCondition[]) =>
    list.flatMap((condition) => {
      const field = fieldsById.get(condition.fieldId);
      return field && isConditionComplete(condition) ? [conditionSql(condition, field, context)] : [];
    });

  const parts = [
    ...conditions(filter.conditions),
    ...filter.groups.flatMap((group) => {
      const inner = conditions(group.conditions);
      return inner.length > 0 ? [combine(inner, group.conjunction === "and" ? "AND" : "OR")] : [];
    }),
  ];
  return parts.length > 0 ? combine(parts, filter.conjunction === "and" ? "AND" : "OR") : { sql: "1 = 1", params: [] };
}

function sortKey(field: Field): SqlFragment {
  switch (field.type) {
    case "singleSelect": {
      // Selects sort by option order, like in Airtable, not by the random option id.
      const cases = field.options.map((option, i) => sql`WHEN ${option.id} THEN ${i}`);
      return cases.length > 0 ? sql`CASE ${cell(field)} ${concat(cases, " ")} END` : cell(field);
    }
    case "text":
    case "email":
    case "url":
      return sql`ulower(${cell(field)})`;
    default:
      return cell(field);
  }
}

/** `seq` (creation order) is the final tie-breaker, so paging over equal values is stable. */
export function compileSorts(sorts: Sort[], fields: Field[]): SqlFragment {
  const fieldsById = new Map(fields.map((field) => [field.id, field]));
  const keys = sorts.flatMap((sort) => {
    const field = fieldsById.get(sort.fieldId);
    if (!field || !isSortable(field)) return [];
    const direction = sort.direction === "asc" ? "ASC" : "DESC";
    const key = sortKey(field);
    return [{ sql: `${key.sql} ${direction} NULLS LAST`, params: key.params }];
  });
  return concat([...keys, { sql: "seq ASC", params: [] }], ", ");
}
