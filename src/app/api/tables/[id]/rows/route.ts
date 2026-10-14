import { z } from "zod";
import { isValidTimeZone } from "@/lib/domain/field";
import { EMPTY_FILTER, filterFieldIssues } from "@/lib/domain/filter";
import { idSchema } from "@/lib/domain/ids";
import { decodeFilterParam, decodeSortParam } from "@/lib/domain/query";
import { isSortable, type Sort } from "@/lib/domain/view";
import { apiRoute, parseSearchParams } from "@/server/api";
import { getCurrentUser } from "@/server/auth";
import { now } from "@/server/clock";
import { ApiError, notFound } from "@/server/errors";
import { linkedRecordLabels, queryRows } from "@/server/rows";
import { getTable, getView } from "@/server/tables";

const MAX_LIMIT = 500;

const querySchema = z.object({
  viewId: idSchema.optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(100),
  /** base64url JSON FilterGroup; overrides the view's filter (unsaved changes, shared links). */
  filter: z.string().optional(),
  /** `fld_a:asc,fld_b:desc`; overrides the view's sorts. */
  sort: z.string().optional(),
  /** The viewer's time zone, for "today" on date fields without their own zone. */
  tz: z.string().refine(isValidTimeZone, "Unknown time zone").default("UTC"),
});

function invalid(param: string, message: string): ApiError {
  return new ApiError("VALIDATION_ERROR", 400, message, { fieldErrors: { [param]: message } });
}

/** A window of rows (`limit ≤ 500`) with the filtered total and footer aggregates. */
export const GET = apiRoute(async (request, context: RouteContext<"/api/tables/[id]/rows">) => {
  await getCurrentUser();
  const table = getTable((await context.params).id);
  if (!table) throw notFound("Table");
  const query = parseSearchParams(request, querySchema);

  let filter = EMPTY_FILTER;
  let sorts: Sort[] = [];
  if (query.viewId) {
    const found = getView(query.viewId);
    // A view of another table is "not found" here, not silently applied to the wrong table.
    if (!found || found.tableId !== table.id) throw notFound("View");
    filter = found.view.filter;
    sorts = found.view.sorts;
  }
  if (query.filter !== undefined) {
    const decoded = decodeFilterParam(query.filter);
    if (!decoded) throw invalid("filter", "Invalid filter");
    const issues = filterFieldIssues(decoded, table.fields);
    if (issues.length > 0) throw invalid("filter", issues[0].message);
    filter = decoded;
  }
  if (query.sort !== undefined) {
    const decoded = decodeSortParam(query.sort);
    if (!decoded) throw invalid("sort", "Invalid sort");
    // Like the filter: a sort on a missing or unsortable field is a mistake to report, not to ignore.
    for (const sort of decoded) {
      const field = table.fields.find((candidate) => candidate.id === sort.fieldId);
      if (!field) throw invalid("sort", "Field no longer exists");
      if (!isSortable(field)) throw invalid("sort", "This field can't be sorted");
    }
    sorts = decoded;
  }

  const result = queryRows(table, {
    filter,
    sorts,
    offset: query.offset,
    limit: query.limit,
    context: { now: now(), timeZone: query.tz },
  });
  const linkedLabels = linkedRecordLabels(table.fields, result.rows, (tableId) => getTable(tableId)?.primaryFieldId ?? null);
  return Response.json({ ...result, offset: query.offset, linkedLabels });
});
