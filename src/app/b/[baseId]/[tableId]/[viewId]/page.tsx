import { notFound } from "next/navigation";
import { connection } from "next/server";
import type { Field } from "@/lib/domain/field";
import { hasRole } from "@/lib/domain/user";
import { routes } from "@/lib/routes";
import { Grid } from "@/features/grid/Grid";
import { BLOCK_SIZE } from "@/features/grid/GridStore";
import { TableTabs } from "@/features/table-shell/TableTabs";
import { ViewTabs } from "@/features/table-shell/ViewTabs";
import { getCurrentUser } from "@/server/auth";
import { now } from "@/server/clock";
import { linkedRecordLabels, queryRows } from "@/server/rows";
import { getBase, getBaseSchema, getTable, getView } from "@/server/tables";

// Matches the grid store's block size, so the first block is complete.
const INITIAL_WINDOW = BLOCK_SIZE;

/** A short key that changes whenever any field changes (FNV-1a of the schema JSON). */
function schemaKey(fields: Field[]): string {
  let hash = 0x811c9dc5;
  for (const char of JSON.stringify(fields)) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193);
  return (hash >>> 0).toString(36);
}

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
  const fieldsByTable = new Map(getBaseSchema(base.id).map((schema) => [schema.tableId, schema.fields]));
  const baseTables = base.tables.map((summary) => ({ id: summary.id, name: summary.name, fields: fieldsByTable.get(summary.id) ?? [] }));
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
      {/* Keyed by view and schema: switching views, or a field change, starts a fresh grid store
          (new columns, recomputed values) instead of patching the old one. */}
      <Grid
        key={`${view.id}:${schemaKey(table.fields)}`}
        tableId={table.id}
        canEdit={hasRole(user.role, "editor")}
        canChangeSchema={hasRole(user.role, "creator")}
        tables={baseTables}
        importHref={hasRole(user.role, "creator") ? routes.importCsv(baseId, tableId) : null}
        tableName={table.name}
        fields={table.fields}
        primaryFieldId={table.primaryFieldId}
        view={view}
        viewVersion={getView(view.id)?.version ?? 0}
        initialWindow={{ ...initialWindow, offset: 0, linkedLabels }}
      />
    </div>
  );
}
