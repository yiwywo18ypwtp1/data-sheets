import { z } from "zod";
import { apiRoute, parseJsonBody } from "@/server/api";
import { getCurrentUser } from "@/server/auth";
import { notFound } from "@/server/errors";
import { matchRecords } from "@/server/rows";
import { getTable } from "@/server/tables";

const bodySchema = z.object({ labels: z.array(z.string().max(1000)).max(20_000) });

/**
 * Finds records by their primary value (trimmed, case-insensitive), for importing link
 * columns: `{ labels: ["Ada", "Bob"] }` → `{ matches: { "Ada": "row_…" } }`. Labels
 * with no record are left out; with several, the first created wins.
 */
export const POST = apiRoute(async (request, context: RouteContext<"/api/tables/[id]/records/match">) => {
  await getCurrentUser();
  const table = getTable((await context.params).id);
  if (!table) throw notFound("Table");
  const { labels } = await parseJsonBody(request, bodySchema);
  return Response.json({ matches: matchRecords(table.id, table.primaryFieldId, labels) });
});
