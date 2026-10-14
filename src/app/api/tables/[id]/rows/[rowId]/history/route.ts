import { z } from "zod";
import type { CellHistoryResponse } from "@/lib/domain/api";
import { idSchema } from "@/lib/domain/ids";
import type { Row } from "@/lib/domain/row";
import { apiRoute, parseSearchParams } from "@/server/api";
import { getCurrentUser } from "@/server/auth";
import { notFound } from "@/server/errors";
import { cellHistory, HISTORY_PAGE } from "@/server/history";
import { getRowsByIds, linkedRecordLabels } from "@/server/rows";
import { getTable } from "@/server/tables";

const querySchema = z.object({
  fieldId: idSchema.optional(),
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(HISTORY_PAGE),
});

/**
 * A record's cell history, newest first (`?fieldId=` for one cell). Anyone who can see
 * the table can read it. The record may have been deleted: its history is still there
 * (undo can bring the record back), so only the table must exist.
 */
export const GET = apiRoute(async (request, context: RouteContext<"/api/tables/[id]/rows/[rowId]/history">) => {
  await getCurrentUser();
  const { id, rowId } = await context.params;
  const table = getTable(id);
  if (!table) throw notFound("Table");
  const query = parseSearchParams(request, querySchema);
  const { entries, next } = cellHistory(table.id, rowId, query);
  if (entries.length === 0 && query.before === undefined && getRowsByIds(table.id, [rowId]).length === 0) throw notFound("Record");

  // Link values are record ids: label them like the grid does, through pseudo-rows of the logged values.
  const valueRows = entries.flatMap((entry): Row[] =>
    [entry.before, entry.after].map((value) => ({ id: "", values: { [entry.fieldId]: value }, createdAt: entry.at, updatedAt: entry.at, rev: 0 })),
  );
  const body: CellHistoryResponse = { entries, next, linkedLabels: linkedRecordLabels(table.fields, valueRows, (tableId) => getTable(tableId)?.primaryFieldId ?? null) };
  return Response.json(body);
});
