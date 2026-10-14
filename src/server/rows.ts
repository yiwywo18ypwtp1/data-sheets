import "server-only";
import type { Field } from "@/lib/domain/field";
import type { FilterGroup } from "@/lib/domain/filter";
import type { Row } from "@/lib/domain/row";
import type { TableMeta } from "@/lib/domain/table";
import type { Sort } from "@/lib/domain/view";
import { getDb } from "./db";
import { compileFilter, compileSorts, type QueryContext } from "./filterSql";
import { toRow, type RowRecord } from "./storage";

/** Footer aggregates for numeric columns, over all rows matching the filter (not just the window). */
export type Aggregates = Record<string, { sum: number; avg: number | null }>;

export type RowWindow = { rows: Row[]; total: number; aggregates: Aggregates };

function isNumeric(field: Field): boolean {
  return field.type === "number" || field.type === "currency" || (field.type === "formula" && field.resultType === "number");
}

export type RowQuery = {
  filter: FilterGroup;
  sorts: Sort[];
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
 * data version (bumped on every row write) and schema version, so a stale entry
 * can never match again and just ages out of the LRU.
 */
type ResultSet = { ids: string[]; aggregates: Aggregates };

const MAX_CACHED_RESULTS = 10; // ~2.5 MB of ids each at 50 000 rows
const resultCache = new Map<string, ResultSet>();
const dataVersions = new Map<string, number>();

/** Called by every write to a table's rows. */
export function markRowsChanged(tableId: string): void {
  dataVersions.set(tableId, (dataVersions.get(tableId) ?? 0) + 1);
}

function cacheKey(tableId: string, schemaVersion: number, query: RowQuery): string {
  // "today" filters change at midnight, so the date is part of the key.
  const today = query.context.now.toISOString().slice(0, 10);
  return JSON.stringify([tableId, dataVersions.get(tableId) ?? 0, schemaVersion, query.filter, query.sorts, query.context.timeZone, today]);
}

function computeResultSet(tableId: string, fields: Field[], query: RowQuery): ResultSet {
  const where = compileFilter(query.filter, fields, query.context);
  const orderBy = compileSorts(query.sorts, fields);
  const numeric = fields.filter(isNumeric);
  const columns = numeric.map((_, i) => `, json_extract(cells, ?) AS n${i}`).join("");

  // One pass returns the ordered ids and the numeric values to aggregate.
  const records = getDb()
    .prepare(`SELECT id${columns} FROM rows WHERE table_id = ? AND (${where.sql}) ORDER BY ${orderBy.sql}`)
    .all(...numeric.map((field) => `$."${field.id}"`), tableId, ...where.params, ...orderBy.params) as Record<string, unknown>[];

  const aggregates: Aggregates = {};
  numeric.forEach((field, i) => {
    let sum = 0;
    let count = 0;
    for (const record of records) {
      const value = record[`n${i}`];
      if (typeof value === "number") {
        sum += value;
        count++;
      }
    }
    aggregates[field.id] = { sum, avg: count > 0 ? sum / count : null };
  });

  return { ids: records.map((record) => record.id as string), aggregates };
}

/**
 * One window of rows for the virtualized grid, plus the total and aggregates for the
 * whole filtered set. Filtering and sorting happen in SQLite, never on the client.
 */
export function queryRows(table: Pick<TableMeta, "id" | "fields" | "version">, query: RowQuery): RowWindow {
  const tableId = table.id;
  const key = cacheKey(tableId, table.version, query);
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
