import { z } from "zod";
import { apiRoute, parseJsonBody } from "@/server/api";
import { getCurrentUser, originOf } from "@/server/auth";
import { addComment, listComments } from "@/server/comments";
import { notFound } from "@/server/errors";
import { getTable } from "@/server/tables";

/** A record's comments, oldest first. */
export const GET = apiRoute(async (_request, context: RouteContext<"/api/tables/[id]/rows/[rowId]/comments">) => {
  await getCurrentUser();
  const { id, rowId } = await context.params;
  const table = getTable(id);
  if (!table) throw notFound("Table");
  return Response.json({ comments: listComments(table.id, rowId) });
});

/** Adds a comment: `{ body }` with mention tokens `@[usr_x]`. Every role may comment. */
export const POST = apiRoute(async (request, context: RouteContext<"/api/tables/[id]/rows/[rowId]/comments">) => {
  const user = await getCurrentUser();
  const { id, rowId } = await context.params;
  const table = getTable(id);
  if (!table) throw notFound("Table");
  // The body's own rules (length, mentions) are checked by addComment with the shared schema.
  const input = await parseJsonBody(request, z.object({ body: z.unknown() }));
  return Response.json({ comment: addComment(table.id, rowId, input, user, originOf(user, request)) }, { status: 201 });
});
