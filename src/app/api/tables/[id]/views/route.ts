import { z } from "zod";
import { apiRoute, parseJsonBody } from "@/server/api";
import { assertRole, getCurrentUser } from "@/server/auth";
import { createView } from "@/server/views";

const bodySchema = z.object({ name: z.string().trim().min(1, "Name is required").max(100), kind: z.enum(["grid", "form"]) });

/** Adds a view (a grid, or a form with a few questions to start from). Editors and creators. */
export const POST = apiRoute(async (request, context: RouteContext<"/api/tables/[id]/views">) => {
  assertRole(await getCurrentUser(), "editor");
  const input = await parseJsonBody(request, bodySchema);
  return Response.json({ view: createView((await context.params).id, input) }, { status: 201 });
});
