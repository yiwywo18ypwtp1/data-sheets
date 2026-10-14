import { apiRoute, etag } from "@/server/api";
import { getCurrentUser } from "@/server/auth";
import { notFound } from "@/server/errors";
import { getTable } from "@/server/tables";

/** Table schema and views. The ETag is the table version, so clients can revalidate cheaply. */
export const GET = apiRoute(async (request, context: RouteContext<"/api/tables/[id]">) => {
  await getCurrentUser();
  const table = getTable((await context.params).id);
  if (!table) throw notFound("Table");

  const tag = etag(table.version);
  if (request.headers.get("if-none-match") === tag) return new Response(null, { status: 304, headers: { ETag: tag } });
  return Response.json({ table }, { headers: { ETag: tag, "Cache-Control": "private, no-cache" } });
});
