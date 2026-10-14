import { z } from "zod";
import { idSchema } from "@/lib/domain/ids";
import { apiRoute, parseJsonBody } from "@/server/api";
import { getCurrentUser } from "@/server/auth";
import { notFound } from "@/server/errors";
import { setPresence } from "@/server/events";
import { getTable } from "@/server/tables";

const bodySchema = z.object({
  clientId: idSchema,
  viewId: idSchema.nullable(),
  cell: z.object({ rowId: idSchema, fieldId: idSchema }).nullable(),
});

/** "This tab is here, on this cell": shown to others as a coloured frame and an avatar. Also a heartbeat. */
export const POST = apiRoute(async (request, context: RouteContext<"/api/tables/[id]/presence">) => {
  const user = await getCurrentUser();
  const table = getTable((await context.params).id);
  if (!table) throw notFound("Table");
  const { clientId, viewId, cell } = await parseJsonBody(request, bodySchema);
  setPresence(table.id, { clientId, userId: user.id, name: user.name, viewId, cell });
  return new Response(null, { status: 204 });
});
