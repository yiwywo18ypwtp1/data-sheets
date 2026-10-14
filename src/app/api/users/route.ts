import { apiRoute } from "@/server/api";
import { getCurrentUser, listUsers } from "@/server/auth";

/** Everyone who can be mentioned, for the comment composer. */
export const GET = apiRoute(async () => {
  await getCurrentUser();
  return Response.json({ users: listUsers().map((user) => ({ id: user.id, name: user.name })) });
});
