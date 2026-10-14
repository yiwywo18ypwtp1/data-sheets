import { connection } from "next/server";
import { apiRoute } from "@/server/api";
import { getCurrentUser } from "@/server/auth";
import { listMentions } from "@/server/comments";

const handle = apiRoute(async () => {
  const user = await getCurrentUser();
  return Response.json(listMentions(user.id));
});

/** The current user's mentions, newest first, and how many are unread. Per request: see /api/users. */
export async function GET(request: Request, context: RouteContext<"/api/mentions">) {
  await connection();
  return handle(request, context);
}
