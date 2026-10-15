import "server-only";
import type { KanbanResponse } from "@/lib/domain/api";
import type { FilterGroup } from "@/lib/domain/filter";
import type { TableMeta } from "@/lib/domain/table";
import type { Sort } from "@/lib/domain/view";
import { now } from "./clock";
import { ApiError } from "./errors";
import { getRowsByIds, linkedRecordLabels, queryGroupedIds } from "./rows";
import { refreshClockFormulas } from "./rowWrites";
import { getTable } from "./tables";

/** Cards loaded per column at first and per "Show more". */
export const KANBAN_PAGE = 50;

/**
 * A board's columns: the rows matching the view's filter, grouped by the single select
 * on the server (the same grouped query the grid uses, so it's cached the same way), in
 * the view's sort order within each column. Every column comes with its full count but
 * only `limit` cards: a column of 10 000 orders is loaded in pages. `column` asks for one
 * column only, from `offset` ("Show more").
 */
export function kanbanColumns(
  table: Pick<TableMeta, "id" | "fields">,
  query: { filter: FilterGroup; sorts: Sort[]; timeZone: string },
  fieldId: string,
  page: { limit: number; column?: string | null; offset?: number },
): KanbanResponse {
  const field = table.fields.find((candidate) => candidate.id === fieldId);
  if (field?.type !== "singleSelect") {
    throw new ApiError("VALIDATION_ERROR", 400, "A board is stacked by a single select field", { fieldErrors: { fieldId: "Not a single select field" } });
  }
  refreshClockFormulas(table.id);
  const { ids, groups } = queryGroupedIds(table, {
    filter: query.filter,
    // The stacking field orders the groups; it can't also be a sort within them.
    sorts: query.sorts.filter((sort) => sort.fieldId !== fieldId),
    groupBy: [fieldId],
    context: { now: now(), timeZone: query.timeZone },
  });
  const byKey = new Map(groups.filter((group) => group.level === 0).map((group) => [group.key === null ? null : String(group.key), group]));
  // "No value" first, then the options in their order (also the columns with no cards).
  const keys = page.column === undefined ? [null, ...field.options.map((option) => option.id)] : [page.column];
  const offset = page.offset ?? 0;

  const columns = keys.map((key) => {
    const group = byKey.get(key);
    const slice = group ? ids.slice(group.start + Math.min(offset, group.count), group.start + Math.min(offset + page.limit, group.count)) : [];
    return { key, count: group?.count ?? 0, rows: getRowsByIds(table.id, [...slice]) };
  });
  const linkedLabels = linkedRecordLabels(table.fields, columns.flatMap((column) => column.rows), (tableId) => getTable(tableId)?.primaryFieldId ?? null);
  return { columns, total: ids.length, linkedLabels };
}
