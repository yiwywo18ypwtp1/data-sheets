import { apiRoute } from "@/server/api";
import { getCurrentUser } from "@/server/auth";
import { listMentions } from "@/server/comments";

/** The current user's mentions, newest first, and how many are unread. */
export const GET = apiRoute(async () => {
  const user = await getCurrentUser();
  return Response.json(listMentions(user.id));
});
