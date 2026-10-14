import { z } from "zod";
import { apiRoute, parseJsonBody } from "@/server/api";
import { assertRole, getCurrentUser, originOf } from "@/server/auth";
import { createField } from "@/server/fields";

/** Creates a field. Formulas are sent with field names (`{Price}`) and validated on the server. */
export const POST = apiRoute(async (request, context: RouteContext<"/api/tables/[id]/fields">) => {
  const user = await getCurrentUser();
  assertRole(user, "creator");
  const input = await parseJsonBody(request, z.record(z.string(), z.unknown()));
  const field = createField((await context.params).id, input, originOf(user, request));
  return Response.json({ field }, { status: 201 });
});
