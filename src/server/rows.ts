import "server-only";
import type { Aggregates, RowGroup, RowWindow } from "@/lib/domain/api";
import type { CellValue } from "@/lib/domain/cell";
import type { Field } from "@/lib/domain/field";
import { usesRelativeDates, type FilterGroup } from "@/lib/domain/filter";
import type { Row } from "@/lib/domain/row";
import type { TableMeta } from "@/lib/domain/table";
import type { Sort } from "@/lib/domain/view";
import { getDb } from "./db";
import { compileFilter, compileSorts, type QueryContext } from "./filterSql";
import { toRow, type RowRecord } from "./storage";

function isNumeric(field: Field): boolean {
  return field.type === "number" || field.type === "currency" || (field.type === "formula" && field.resultType === "number");
}

export type RowQuery = {
  filter: FilterGroup;
  sorts: Sort[];
  /** Up to two fields to group by: rows are ordered by them first. */
  groupBy?: string[];
  /** Include the group structure in the answer (the grid asks once per query). */
  withGroups?: boolean;
  offset: number;
  limit: number;
  context: QueryContext;
};

/**
 * The full filtered + sorted result of a query, as ids, plus its aggregates.
 *
 * Why cache it: filtering and sorting 50 000 JSON rows takes 200–700 ms, and a
 * scrolling grid asks for many windows of the same query. Computing the id list
 * once and slicing it makes every following window a primary-key lookup of ≤ 500 rows.
 *
 * Invalidation is by key, not by deleting entries: the key includes the table's
 * data version (bumped on every row write) and its fields, so a stale entry can never
 * match again and just ages out of the LRU. Not the table version: that also changes
 * when any view is saved (a column resize), which doesn't change any result.
 */
type ResultSet = { ids: string[]; aggregates: Aggregates; groups: RowGroup[] };

const MAX_CACHED_RESULTS = 10; // ~2.5 MB of ids each at 50 000 rows
/**
 * On globalThis, like the DB connection: Next.js bundles route handlers, pages and Server
 * Actions separately, and each bundle can get its own copy of this module. With module
 * state, rows written by a Server Action (the CSV import) didn't invalidate the cache the
 * rows endpoint reads.
 */
const shared = globalThis as unknown as { rowResults?: { cache: Map<string, ResultSet>; versions: Map<string, number> } };
shared.rowResults ??= { cache: new Map(), versions: new Map() };
const resultCache = shared.rowResults.cache;
const dataVersions = shared.rowResults.versions;

/** Called by every write to a table's rows. */
export function markRowsChanged(tableId: string): void {
  dataVersions.set(tableId, (dataVersions.get(tableId) ?? 0) + 1);
}

/** "Today" filters change at midnight in the field's or viewer's zone; some zones are offset by 30 or 45 minutes. */
const RELATIVE_DATE_TTL_MS = 15 * 60_000;

function cacheKey(table: Pick<TableMeta, "id" | "fields">, query: RowQuery): string {
  const clock = usesRelativeDates(query.filter) ? Math.floor(query.context.now.getTime() / RELATIVE_DATE_TTL_MS) : null;
  return JSON.stringify([table.id, dataVersions.get(table.id) ?? 0, table.fields, query.filter, query.sorts, query.groupBy ?? [], query.context.timeZone, clock]);
}

function sumsOf(values: unknown[][], numericCount: number): Aggregates[string][] {
  return Array.from({ length: numericCount }, (_, i) => {
    let sum = 0;
    let count = 0;
    for (const record of values) {
      const value = record[i];
      if (typeof value === "number") {
        sum += value;
        count++;
      }
    }
    return { sum, avg: count > 0 ? sum / count : null };
  });
}

function computeResultSet(tableId: string, fields: Field[], query: RowQuery): ResultSet {
  const groupFields = (query.groupBy ?? []).flatMap((id) => fields.filter((field) => field.id === id));
  const where = compileFilter(query.filter, fields, query.context);
  // Groups come first in the order, so each group's rows are contiguous; the view's sorts order rows within a group.
  const orderBy = compileSorts([...groupFields.map((field) => ({ fieldId: field.id, direction: "asc" as const })), ...query.sorts.filter((sort) => !groupFields.some((field) => field.id === sort.fieldId))], fields);
  const numeric = fields.filter(isNumeric);
  const columns = [...numeric.map((_, i) => `, json_extract(cells, ?) AS n${i}`), ...groupFields.map((_, i) => `, json_extract(cells, ?) AS g${i}`)].join("");

  // One pass returns the ordered ids, the numeric values to aggregate and the group keys.
  const records = getDb()
    .prepare(`SELECT id${columns} FROM rows WHERE table_id = ? AND (${where.sql}) ORDER BY ${orderBy.sql}`)
    .all(...numeric.map((field) => `$."${field.id}"`), ...groupFields.map((field) => `$."${field.id}"`), tableId, ...where.params, ...orderBy.params) as Record<string, unknown>[];

  const numbers = records.map((record) => numeric.map((_, i) => record[`n${i}`]));
  const aggregatesOf = (from: number, to: number): Aggregates => {
    const sums = sumsOf(numbers.slice(from, to), numeric.length);
    return Object.fromEntries(numeric.map((field, i) => [field.id, sums[i]]));
  };

  const groups: RowGroup[] = [];
  if (groupFields.length > 0) {
    const keyOf = (record: Record<string, unknown>, level: number) => (record[`g${level}`] ?? null) as CellValue;
    let top = 0;
    while (top < records.length) {
      const topKey = keyOf(records[top], 0);
      let end = top;
      while (end < records.length && keyOf(records[end], 0) === topKey) end++;
      groups.push({ level: 0, fieldId: groupFields[0].id, key: topKey, start: top, count: end - top, aggregates: aggregatesOf(top, end) });
      if (groupFields.length > 1) {
        let sub = top;
        while (sub < end) {
          const subKey = keyOf(records[sub], 1);
          let subEnd = sub;
          while (subEnd < end && keyOf(records[subEnd], 1) === subKey) subEnd++;
          groups.push({ level: 1, fieldId: groupFields[1].id, key: subKey, start: sub, count: subEnd - sub, aggregates: aggregatesOf(sub, subEnd) });
          sub = subEnd;
        }
      }
      top = end;
    }
  }

  return { ids: records.map((record) => record.id as string), aggregates: aggregatesOf(0, records.length), groups };
}

/**
 * One window of rows for the virtualized grid, plus the total and aggregates for the
 * whole filtered set. Filtering and sorting happen in SQLite, never on the client.
 */
export function queryRows(table: Pick<TableMeta, "id" | "fields">, query: RowQuery): RowWindow {
  const tableId = table.id;
  const key = cacheKey(table, query);
  let resultSet = resultCache.get(key);
  if (resultSet) {
    resultCache.delete(key); // re-insert to mark as most recently used
  } else {
    resultSet = computeResultSet(tableId, table.fields, query);
    if (resultCache.size >= MAX_CACHED_RESULTS) resultCache.delete(resultCache.keys().next().value!);
  }
  resultCache.set(key, resultSet);

  const ids = resultSet.ids.slice(query.offset, query.offset + query.limit);
  return {
    rows: getRowsByIds(tableId, ids),
    total: resultSet.ids.length,
    aggregates: resultSet.aggregates,
    ...(query.withGroups && (query.groupBy?.length ?? 0) > 0 ? { groups: resultSet.groups } : {}),
  };
}

/** Rows in the order of `ids`; ids that no longer exist are skipped. */
export function getRowsByIds(tableId: string, ids: string[]): Row[] {
  if (ids.length === 0) return [];
  const records = getDb()
    .prepare(`SELECT * FROM rows WHERE table_id = ? AND id IN (${ids.map(() => "?").join(", ")})`)
    .all(tableId, ...ids) as RowRecord[];
  const byId = new Map(records.map((record) => [record.id, record]));
  return ids.flatMap((id) => {
    const record = byId.get(id);
    return record ? [toRow(record)] : [];
  });
}

/**
 * Link cells store row ids; the grid shows the linked records' primary values.
 * Returns `{ rowId: label }` for every record linked from `rows`, one query per target table.
 */
export function linkedRecordLabels(fields: Field[], rows: Row[], primaryFieldOf: (tableId: string) => string | null): Record<string, string> {
  const idsByTable = new Map<string, Set<string>>();
  for (const field of fields) {
    if (field.type !== "link") continue;
    for (const row of rows) {
      const ids = row.values[field.id];
      if (!Array.isArray(ids)) continue;
      if (!idsByTable.has(field.targetTableId)) idsByTable.set(field.targetTableId, new Set());
      for (const id of ids) idsByTable.get(field.targetTableId)!.add(id);
    }
  }

  const labels: Record<string, string> = {};
  for (const [tableId, ids] of idsByTable) {
    const primaryFieldId = primaryFieldOf(tableId);
    for (const row of getRowsByIds(tableId, [...ids])) {
      const value = primaryFieldId ? row.values[primaryFieldId] : null;
      labels[row.id] = value === null || value === undefined ? "Unnamed record" : String(value);
    }
  }
  return labels;
}

export type RecordOption = { id: string; label: string };

/** Records whose primary value contains `q` (case-insensitive), for the link cell editor. */
export function searchRecords(tableId: string, primaryFieldId: string, q: string, limit: number): RecordOption[] {
  const records = getDb()
    .prepare(
      `SELECT id, json_extract(cells, ?) AS label FROM rows
       WHERE table_id = ? AND instr(ulower(coalesce(json_extract(cells, ?), '')), ?) > 0
       ORDER BY seq LIMIT ?`,
    )
    .all(`$."${primaryFieldId}"`, tableId, `$."${primaryFieldId}"`, q.trim().toLowerCase(), limit) as { id: string; label: unknown }[];
  return records.map((record) => ({ id: record.id, label: record.label === null ? "Unnamed record" : String(record.label) }));
}

/** Record ids by primary value (trimmed, case-insensitive; the earliest record wins), for importing link columns. */
export function matchRecords(tableId: string, primaryFieldId: string, labels: string[]): Record<string, string> {
  const wanted = new Map(labels.map((label) => [label.trim().toLowerCase(), label]));
  const records = getDb()
    .prepare("SELECT id, json_extract(cells, ?) AS label FROM rows WHERE table_id = ? ORDER BY seq")
    .all(`$."${primaryFieldId}"`, tableId) as { id: string; label: unknown }[];
  const matches: Record<string, string> = {};
  for (const record of records) {
    if (record.label === null || record.label === undefined) continue;
    const label = wanted.get(String(record.label).trim().toLowerCase());
    if (label !== undefined && !(label in matches)) matches[label] = record.id;
  }
  return matches;
}
