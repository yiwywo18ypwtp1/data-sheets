import "server-only";
import { cookies } from "next/headers";
import { idSchema } from "@/lib/domain/ids";
import { hasRole, type Role, type User } from "@/lib/domain/user";
import { getDb } from "./db";
import { ApiError } from "./errors";

/** Mock auth: the current user is picked on /settings and kept in this cookie. */
export const USER_COOKIE = "ds_user";

/** Without a cookie you act as the creator, so every feature works on a fresh checkout. */
const DEFAULT_USER_ID = "usr_creator";

/** The user a cookie value stands for: unknown or missing values act as the default user, like `getCurrentUser`. */
export function resolveUserId(cookieValue: string | undefined): string {
  return cookieValue && findUser(cookieValue) ? cookieValue : DEFAULT_USER_ID;
}

export function listUsers(): User[] {
  return getDb().prepare("SELECT id, name, role FROM users ORDER BY rowid").all() as User[];
}

export function findUser(id: string): User | null {
  return (getDb().prepare("SELECT id, name, role FROM users WHERE id = ?").get(id) as User | undefined) ?? null;
}

export async function getCurrentUser(): Promise<User> {
  const id = (await cookies()).get(USER_COOKIE)?.value ?? DEFAULT_USER_ID;
  const user = findUser(id) ?? findUser(DEFAULT_USER_ID);
  if (!user) throw new ApiError("UNAUTHORIZED", 401, "Unknown user");
  return user;
}

/**
 * The server-side permission check. Every Route Handler and Server Action that
 * changes data calls it; hiding buttons in the UI is only a convenience.
 */
export function assertRole(user: User, required: Role): void {
  if (!hasRole(user.role, required)) {
    throw new ApiError("FORBIDDEN", 403, `This action requires the ${required} role; you are a ${user.role}`);
  }
}

/** Header a page sends with its writes: the user it was opened for (see `apiRoute`). */
export const ACTING_USER_HEADER = "x-acting-user";

/** Header a browser tab sends with its writes, so it can recognise (and skip) its own realtime events. */
export const CLIENT_ID_HEADER = "x-client-id";

/** Who a change comes from, for the realtime events. */
export function originOf(user: User, request?: Request): { userId: string; name: string; clientId: string | null } {
  const clientId = idSchema.safeParse(request?.headers.get(CLIENT_ID_HEADER));
  return { userId: user.id, name: user.name, clientId: clientId.success ? clientId.data : null };
}
