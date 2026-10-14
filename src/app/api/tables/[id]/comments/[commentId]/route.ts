import { apiRoute } from "@/server/api";
import { getCurrentUser, originOf } from "@/server/auth";
import { deleteComment } from "@/server/comments";
import { notFound } from "@/server/errors";
import { getTable } from "@/server/tables";

/** Deletes a comment; only its author may. */
export const DELETE = apiRoute(async (request, context: RouteContext<"/api/tables/[id]/comments/[commentId]">) => {
  const user = await getCurrentUser();
  const { id, commentId } = await context.params;
  const table = getTable(id);
  if (!table) throw notFound("Table");
  deleteComment(table.id, commentId, user, originOf(user, request));
  return new Response(null, { status: 204 });
});
