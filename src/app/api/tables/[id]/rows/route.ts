import { z } from "zod";
import { apiRoute, parseSearchParams } from "@/server/api";
import { getCurrentUser } from "@/server/auth";
import { now } from "@/server/clock";
import { notFound } from "@/server/errors";
import { resolveRowQuery, rowQueryParamsSchema } from "@/server/rowQuery";
import { linkedRecordLabels, queryRows } from "@/server/rows";
import { getTable } from "@/server/tables";

const MAX_LIMIT = 500;

const querySchema = rowQueryParamsSchema.extend({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(100),
  /** `1`: include the group structure (positions, counts, aggregates of every group). */
  withGroups: z.enum(["0", "1"]).optional(),
});

/** A window of rows (`limit ≤ 500`) with the filtered total and footer aggregates. */
export const GET = apiRoute(async (request, context: RouteContext<"/api/tables/[id]/rows">) => {
  await getCurrentUser();
  const table = getTable((await context.params).id);
  if (!table) throw notFound("Table");
  const params = parseSearchParams(request, querySchema);
  const { filter, sorts, groupBy, timeZone } = resolveRowQuery(table, params);

  const result = queryRows(table, {
    filter,
    sorts,
    groupBy,
    withGroups: params.withGroups === "1",
    offset: params.offset,
    limit: params.limit,
    context: { now: now(), timeZone },
  });
  const linkedLabels = linkedRecordLabels(table.fields, result.rows, (tableId) => getTable(tableId)?.primaryFieldId ?? null);
  return Response.json({ ...result, offset: params.offset, linkedLabels });
});
