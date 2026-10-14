import { connection } from "next/server";
import { apiRoute } from "@/server/api";
import { getCurrentUser } from "@/server/auth";
import { listMentions } from "@/server/comments";

/** The current user's mentions, newest first, and how many are unread. */
export const GET = apiRoute(async () => {
  // Per user (a cookie), never prerendered at build time.
  await connection();
  const user = await getCurrentUser();
  return Response.json(listMentions(user.id));
});
