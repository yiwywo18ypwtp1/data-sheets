import { z } from "zod";
import { idSchema } from "@/lib/domain/ids";
import { apiRoute, parseSearchParams } from "@/server/api";
import { getCurrentUser } from "@/server/auth";
import { notFound } from "@/server/errors";
import { KANBAN_PAGE, kanbanColumns } from "@/server/kanban";
import { resolveRowQuery, rowQueryParamsSchema } from "@/server/rowQuery";
import { getTable } from "@/server/tables";

/** The column with no value is addressed as `column=` (empty). */
const querySchema = rowQueryParamsSchema.extend({
  fieldId: idSchema,
  limit: z.coerce.number().int().min(1).max(500).default(KANBAN_PAGE),
  column: z.union([idSchema, z.literal("")]).optional(),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * A kanban board's columns (the options of `fieldId`) with their counts and the first
 * `limit` cards each, for the view's query or the URL's unsaved one, like `GET /rows`.
 * With `column`, only that column from `offset`.
 */
export const GET = apiRoute(async (request, context: RouteContext<"/api/tables/[id]/kanban">) => {
  await getCurrentUser();
  const table = getTable((await context.params).id);
  if (!table) throw notFound("Table");
  const params = parseSearchParams(request, querySchema);
  const { filter, sorts, timeZone } = resolveRowQuery(table, params);
  const column = params.column === undefined ? undefined : params.column === "" ? null : params.column;
  return Response.json(kanbanColumns(table, { filter, sorts, timeZone }, params.fieldId, { limit: params.limit, column, offset: params.offset }));
});
