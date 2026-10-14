import { z } from "zod";
import { idSchema } from "@/lib/domain/ids";
import { apiRoute, parseJsonBody } from "@/server/api";
import { getCurrentUser } from "@/server/auth";
import { markMentionsRead } from "@/server/comments";

/** `{ commentIds }` marks those mentions read; without it, all of them. */
export const POST = apiRoute(async (request) => {
  const user = await getCurrentUser();
  const { commentIds } = await parseJsonBody(request, z.object({ commentIds: z.array(idSchema).max(500).optional() }));
  markMentionsRead(user.id, commentIds ?? null);
  return new Response(null, { status: 204 });
});
