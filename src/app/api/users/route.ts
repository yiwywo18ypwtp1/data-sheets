import { connection } from "next/server";
import { apiRoute } from "@/server/api";
import { getCurrentUser, listUsers } from "@/server/auth";

/** Everyone who can be mentioned, for the comment composer. */
export const GET = apiRoute(async () => {
  // Per user (a cookie), never prerendered at build time.
  await connection();
  await getCurrentUser();
  return Response.json({ users: listUsers().map((user) => ({ id: user.id, name: user.name })) });
});
