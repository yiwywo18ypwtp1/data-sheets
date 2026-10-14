import "server-only";
import { z } from "zod";
import { isValidTimeZone } from "@/lib/domain/field";
import { EMPTY_FILTER, filterFieldIssues, type FilterGroup } from "@/lib/domain/filter";
import { idSchema } from "@/lib/domain/ids";
import { decodeFilterParam, decodeSortParam } from "@/lib/domain/query";
import type { TableMeta } from "@/lib/domain/table";
import { isSortable, type Sort, type View } from "@/lib/domain/view";
import { ApiError, notFound } from "./errors";
import { getView } from "./tables";

/**
 * Which rows, in what order: a view's saved query, optionally overridden by the URL
 * (an unsaved filter, sort or grouping). Shared by `GET /rows` and `GET /export`, so the
 * export gives exactly the rows the grid shows, and both reject the same bad input.
 */
export const rowQueryParamsSchema = z.object({
  viewId: idSchema.optional(),
  /** base64url JSON FilterGroup; overrides the view's filter (unsaved changes, shared links). */
  filter: z.string().optional(),
  /** `fld_a:asc,fld_b:desc`; overrides the view's sorts. */
  sort: z.string().optional(),
  /** `fld_a,fld_b` (at most two); overrides the view's grouping. Empty: no grouping. */
  group: z.string().optional(),
  /** The viewer's time zone, for "today" on date fields without their own zone. */
  tz: z.string().refine(isValidTimeZone, "Unknown time zone").default("UTC"),
});
export type RowQueryParams = z.output<typeof rowQueryParamsSchema>;

export type ResolvedRowQuery = { view: View | null; filter: FilterGroup; sorts: Sort[]; groupBy: string[]; timeZone: string };

function invalid(param: string, message: string): ApiError {
  return new ApiError("VALIDATION_ERROR", 400, message, { fieldErrors: { [param]: message } });
}

export function resolveRowQuery(table: Pick<TableMeta, "id" | "fields">, params: RowQueryParams): ResolvedRowQuery {
  let view: View | null = null;
  let filter = EMPTY_FILTER;
  let sorts: Sort[] = [];
  let groupBy: string[] = [];
  if (params.viewId) {
    const found = getView(params.viewId);
    // A view of another table is "not found" here, not silently applied to the wrong table.
    if (!found || found.tableId !== table.id) throw notFound("View");
    view = found.view;
    filter = found.view.filter;
    sorts = found.view.sorts;
    groupBy = (found.view.groupBy ?? []).map((group) => group.fieldId);
  }
  if (params.filter !== undefined) {
    const decoded = decodeFilterParam(params.filter);
    if (!decoded) throw invalid("filter", "Invalid filter");
    const issues = filterFieldIssues(decoded, table.fields);
    if (issues.length > 0) throw invalid("filter", issues[0].message);
    filter = decoded;
  }
  if (params.sort !== undefined) {
    const decoded = decodeSortParam(params.sort);
    if (!decoded) throw invalid("sort", "Invalid sort");
    // Like the filter: a sort on a missing or unsortable field is a mistake to report, not to ignore.
    for (const sort of decoded) {
      const field = table.fields.find((candidate) => candidate.id === sort.fieldId);
      if (!field) throw invalid("sort", "Field no longer exists");
      if (!isSortable(field)) throw invalid("sort", "This field can't be sorted");
    }
    sorts = decoded;
  }
  if (params.group !== undefined) {
    groupBy = params.group === "" ? [] : params.group.split(",");
    if (groupBy.length > 2 || new Set(groupBy).size !== groupBy.length) throw invalid("group", "Group by at most two different fields");
    for (const fieldId of groupBy) {
      const field = table.fields.find((candidate) => candidate.id === fieldId);
      if (!field) throw invalid("group", "Field no longer exists");
      if (!isSortable(field)) throw invalid("group", "This field can't be grouped by");
    }
  }
  return { view, filter, sorts, groupBy, timeZone: params.tz };
}
