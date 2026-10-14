import { z } from "zod";
import { apiRoute, etag, parseIfMatch, parseJsonBody } from "@/server/api";
import { assertRole, getCurrentUser, originOf } from "@/server/auth";
import { saveView } from "@/server/views";

/** Replaces a view. Requires `If-Match: "<version>"`; 412 with the current view on a stale version. */
export const PUT = apiRoute(async (request, context: RouteContext<"/api/views/[id]">) => {
  const user = await getCurrentUser();
  assertRole(user, "editor");
  const input = await parseJsonBody(request, z.unknown());
  const { view, version } = saveView((await context.params).id, input, parseIfMatch(request), originOf(user, request));
  return Response.json({ view, version }, { headers: { ETag: etag(version) } });
});
