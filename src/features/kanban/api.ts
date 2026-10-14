import type { KanbanResponse } from "@/lib/domain/api";
import { encodeFilterParam, encodeSortParam } from "@/lib/domain/query";
import { request, type RowQuery } from "@/features/grid/api";

/** A board's columns for the current (possibly unsaved) filter and sorts; `column` loads more of one column. */
export function fetchKanban(
  tableId: string,
  query: Omit<RowQuery, "groupBy">,
  fieldId: string,
  page: { limit: number; column?: string | null; offset?: number },
  signal?: AbortSignal,
): Promise<KanbanResponse> {
  const params = new URLSearchParams({
    fieldId,
    filter: encodeFilterParam(query.filter),
    sort: encodeSortParam(query.sorts),
    tz: query.timeZone,
    limit: String(page.limit),
  });
  if (page.column !== undefined) params.set("column", page.column ?? "");
  if (page.offset) params.set("offset", String(page.offset));
  return request<KanbanResponse>(`/api/tables/${tableId}/kanban?${params}`, { signal });
}
