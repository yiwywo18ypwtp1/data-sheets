import { notFound } from "next/navigation";
import { connection } from "next/server";
import { hasRole } from "@/lib/domain/user";
import { TableTabs } from "@/features/table-shell/TableTabs";
import { ViewTabs } from "@/features/table-shell/ViewTabs";
import { getCurrentUser } from "@/server/auth";
import { now } from "@/server/clock";
import { linkedRecordLabels, queryRows } from "@/server/rows";
import { getBase, getTable } from "@/server/tables";

const INITIAL_WINDOW = 100;

/**
 * Server Component: loads the shell data (base, table schema, view, user) and the
 * first window of rows, so the grid renders with data instead of an empty flash.
 * Everything interactive below this page is a Client Component that gets plain props.
 *
 * The segment's loading.tsx is the Suspense boundary for the params/cookie reads.
 */
export default async function ViewPage({ params }: PageProps<"/b/[baseId]/[tableId]/[viewId]">) {
  const { baseId, tableId, viewId } = await params;
  // Rows and "now" must be read per request. Prefetching can prerender with params and
  // cookies known, and better-sqlite3 is synchronous, so we opt out explicitly.
  await connection();
  const user = await getCurrentUser();

  const base = getBase(baseId);
  const table = getTable(tableId);
  // Ids that exist but don't belong together (a view of another table) are a 404 too.
  if (!base || !table || table.baseId !== baseId) notFound();
  const view = table.views.find((candidate) => candidate.id === viewId);
  if (!view) notFound();

  // The viewer's time zone isn't known on the server; UTC only matters for "today" filters.
  const initialWindow = queryRows(table, {
    filter: view.filter,
    sorts: view.sorts,
    offset: 0,
    limit: INITIAL_WINDOW,
    context: { now: now(), timeZone: "UTC" },
  });
  const linkedLabels = linkedRecordLabels(table.fields, initialWindow.rows, (id) => getTable(id)?.primaryFieldId ?? null);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-end gap-4 bg-zinc-100 px-4 pt-2 dark:bg-zinc-950">
        <span className="pb-1.5 text-sm font-semibold text-zinc-500">{base.name}</span>
        <TableTabs baseId={baseId} tables={base.tables} activeTableId={tableId} />
      </div>
      <div className="flex items-center gap-4 border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
        <ViewTabs baseId={baseId} tableId={tableId} views={table.views} activeViewId={viewId} />
        {!hasRole(user.role, "editor") && (
          <span className="ml-auto rounded bg-amber-50 px-2 py-0.5 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-300">
            Read-only: you are a viewer
          </span>
        )}
      </div>
      {/* Replaced by the virtualized grid in the next phase. */}
      <section aria-label={`${table.name} records`} className="flex-1 p-4 text-sm text-zinc-500">
        {initialWindow.total.toLocaleString("en-US")} records · {table.fields.length} fields · first window: {initialWindow.rows.length} rows,{" "}
        {Object.keys(linkedLabels).length} linked labels
      </section>
    </div>
  );
}
