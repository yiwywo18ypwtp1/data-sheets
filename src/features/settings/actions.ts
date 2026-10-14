"use server";

import { cookies } from "next/headers";
import { z } from "zod";
import { idSchema } from "@/lib/domain/ids";
import { findUser, USER_COOKIE } from "@/server/auth";

const schema = z.object({ userId: idSchema });

/**
 * Switches the mock user. Setting a cookie in a Server Action makes Next.js re-render
 * the current page, so every server-side role check immediately uses the new user.
 */
export async function switchUser(formData: FormData): Promise<void> {
  const { userId } = schema.parse({ userId: formData.get("userId") });
  if (!findUser(userId)) throw new Error("Unknown user");
  (await cookies()).set(USER_COOKIE, userId, { httpOnly: true, sameSite: "lax", path: "/" });
}
