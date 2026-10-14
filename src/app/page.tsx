import { redirect } from "next/navigation";
import { connection } from "next/server";
import { routes } from "@/lib/routes";
import { getDefaultView, getFirstBaseId } from "@/server/tables";

/** This page only redirects; there's nothing to show while it decides, so blocking is fine. */
export const instant = false;

export default async function Home() {
  // better-sqlite3 is synchronous: without this, the query would run once at build time.
  await connection();
  const baseId = getFirstBaseId();
  const target = baseId ? getDefaultView(baseId) : null;
  if (!baseId || !target) return <p className="p-8">No bases yet.</p>;
  redirect(routes.view(baseId, target.tableId, target.viewId));
}
