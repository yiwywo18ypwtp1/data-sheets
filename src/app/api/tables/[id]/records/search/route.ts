import { z } from "zod";
import { apiRoute, parseSearchParams } from "@/server/api";
import { getCurrentUser } from "@/server/auth";
import { notFound } from "@/server/errors";
import { searchRecords } from "@/server/rows";
import { getTable } from "@/server/tables";

const querySchema = z.object({
  q: z.string().max(200).default(""),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

/** Records of this table matching `q` by primary value: options for the link cell editor. */
export const GET = apiRoute(async (request, context: RouteContext<"/api/tables/[id]/records/search">) => {
  await getCurrentUser();
  const table = getTable((await context.params).id);
  if (!table) throw notFound("Table");
  const { q, limit } = parseSearchParams(request, querySchema);
  return Response.json({ records: searchRecords(table.id, table.primaryFieldId, q, limit) });
});
