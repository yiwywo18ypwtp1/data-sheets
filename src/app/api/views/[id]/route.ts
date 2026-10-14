import { z } from "zod";
import { apiRoute, etag, parseIfMatch, parseJsonBody } from "@/server/api";
import { assertRole, getCurrentUser } from "@/server/auth";
import { saveView } from "@/server/views";

/** Replaces a view. Requires `If-Match: "<version>"`; 412 with the current view on a stale version. */
export const PUT = apiRoute(async (request, context: RouteContext<"/api/views/[id]">) => {
  assertRole(await getCurrentUser(), "editor");
  const input = await parseJsonBody(request, z.unknown());
  const { view, version } = saveView((await context.params).id, input, parseIfMatch(request));
  return Response.json({ view, version }, { headers: { ETag: etag(version) } });
});
