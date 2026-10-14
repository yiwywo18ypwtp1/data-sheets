import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { hasRole } from "@/lib/domain/user";
import { routes } from "@/lib/routes";
import { ImportWizard } from "@/features/import/ImportWizard";
import { getCurrentUser } from "@/server/auth";
import { getBase, getTable } from "@/server/tables";

/**
 * Server Component shell of the CSV import: checks the table and the user's role, and
 * hands the table's fields to the wizard, which runs entirely on the client (parsing
 * in a Web Worker) and imports through a Server Action.
 */
export default async function ImportPage({ params }: PageProps<"/b/[baseId]/[tableId]/import">) {
  const { baseId, tableId } = await params;
  await connection();
  const user = await getCurrentUser();
  const base = getBase(baseId);
  const table = getTable(tableId);
  if (!base || !table || table.baseId !== baseId) notFound();
  const viewHref = routes.view(baseId, tableId, table.views[0].id);

  if (!hasRole(user.role, "creator")) {
    return (
      <div className="m-8 space-y-3 text-sm">
        <p>Importing can create fields, so it needs the creator role; you are {user.role === "editor" ? "an editor" : "a viewer"}.</p>
        <Link href={viewHref} className="text-blue-600 hover:underline">
          Back to {table.name}
        </Link>
      </div>
    );
  }
  return <ImportWizard tableId={table.id} tableName={table.name} fields={table.fields} viewHref={viewHref} />;
}
