import Link from "next/link";
import { routes } from "@/lib/routes";
import { getCurrentUser } from "@/server/auth";

export async function CurrentUserBadge() {
  const user = await getCurrentUser();
  return (
    <Link href={routes.settings()} className="text-sm text-zinc-600 hover:underline dark:text-zinc-300">
      {user.name} <span className="text-zinc-400">· {user.role}</span>
    </Link>
  );
}
