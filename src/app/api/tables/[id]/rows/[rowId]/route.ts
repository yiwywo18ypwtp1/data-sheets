import type { RowResponse } from "@/lib/domain/api";
import { apiRoute } from "@/server/api";
import { getCurrentUser } from "@/server/auth";
import { notFound } from "@/server/errors";
import { getRowsByIds, linkedRecordLabels } from "@/server/rows";
import { refreshClockFormulas } from "@/server/rowWrites";
import { getTable } from "@/server/tables";

/** One record, for the record panel opened from a link (`?record=`) when its row isn't loaded. */
export const GET = apiRoute(async (_request, context: RouteContext<"/api/tables/[id]/rows/[rowId]">) => {
  await getCurrentUser();
  const { id, rowId } = await context.params;
  const table = getTable(id);
  if (!table) throw notFound("Table");
  refreshClockFormulas(table.id);
  const [row] = getRowsByIds(table.id, [rowId]);
  if (!row) throw notFound("Record");
  const body: RowResponse = { row, linkedLabels: linkedRecordLabels(table.fields, [row], (tableId) => getTable(tableId)?.primaryFieldId ?? null) };
  return Response.json(body);
});
