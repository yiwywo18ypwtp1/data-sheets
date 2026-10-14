import { rowBatchSchema } from "@/lib/domain/row";
import { apiRoute, parseJsonBody } from "@/server/api";
import { assertRole, getCurrentUser } from "@/server/auth";
import { notFound } from "@/server/errors";
import { applyRowBatch } from "@/server/rowWrites";
import { getTable } from "@/server/tables";

/** Up to 1 000 create/update/delete ops. Answers 200 with a result per op (partial success). */
export const POST = apiRoute(async (request, context: RouteContext<"/api/tables/[id]/rows/batch">) => {
  assertRole(await getCurrentUser(), "editor");
  const table = getTable((await context.params).id);
  if (!table) throw notFound("Table");
  const { ops } = await parseJsonBody(request, rowBatchSchema);
  return Response.json({ results: applyRowBatch(table, ops) });
});
