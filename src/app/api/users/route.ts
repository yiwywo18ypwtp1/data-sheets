import { connection } from "next/server";
import { apiRoute } from "@/server/api";
import { getCurrentUser, listUsers } from "@/server/auth";

const handle = apiRoute(async () => {
  await getCurrentUser();
  return Response.json({ users: listUsers().map((user) => ({ id: user.id, name: user.name })) });
});

/**
 * Everyone who can be mentioned, for the comment composer. `connection()` comes first,
 * outside `apiRoute`'s error handling: it's how the build learns this answer is per
 * request (a cookie) and must not be prerendered, which it signals by rejecting.
 */
export async function GET(request: Request, context: RouteContext<"/api/users">) {
  await connection();
  return handle(request, context);
}
