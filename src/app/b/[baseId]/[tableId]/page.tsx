import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { routes } from "@/lib/routes";
import { getDefaultView } from "@/server/tables";

export const instant = false;

export default async function TablePage({ params }: PageProps<"/b/[baseId]/[tableId]">) {
  const { baseId, tableId } = await params;
  await connection();
  const target = getDefaultView(baseId, tableId);
  if (!target) notFound();
  redirect(routes.view(baseId, target.tableId, target.viewId));
}
