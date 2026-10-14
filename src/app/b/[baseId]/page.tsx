import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { routes } from "@/lib/routes";
import { getDefaultView } from "@/server/tables";

export const instant = false;

export default async function BasePage({ params }: PageProps<"/b/[baseId]">) {
  const { baseId } = await params;
  await connection();
  const target = getDefaultView(baseId);
  if (!target) notFound();
  redirect(routes.view(baseId, target.tableId, target.viewId));
}
