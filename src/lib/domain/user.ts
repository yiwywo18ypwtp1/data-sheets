import { z } from "zod";
import { idSchema } from "./ids";

export const roleSchema = z.enum(["viewer", "editor", "creator"]);
export type Role = z.infer<typeof roleSchema>;

export const userSchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  role: roleSchema,
});
export type User = z.infer<typeof userSchema>;

const ROLE_RANK: Record<Role, number> = { viewer: 0, editor: 1, creator: 2 };

/** Roles are ordered: a creator can do everything an editor can, and so on. */
export function hasRole(role: Role, required: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[required];
}
