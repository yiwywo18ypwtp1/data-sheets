import Link from "next/link";
import { routes } from "@/lib/routes";
import type { TableSummary } from "@/server/tables";

/** Server-rendered navigation: plain links, no client state. */
export function TableTabs({ baseId, tables, activeTableId }: { baseId: string; tables: TableSummary[]; activeTableId: string }) {
  return (
    <nav aria-label="Tables" className="flex gap-1">
      {tables.map((table) => {
        const active = table.id === activeTableId;
        return (
          <Link
            key={table.id}
            href={routes.view(baseId, table.id, table.defaultViewId)}
            aria-current={active ? "page" : undefined}
            className={`rounded-t px-3 py-1.5 text-sm ${
              active ? "bg-white font-medium shadow-sm dark:bg-zinc-900" : "text-zinc-600 hover:bg-zinc-200/60 dark:text-zinc-300 dark:hover:bg-zinc-800"
            }`}
          >
            {table.name}
          </Link>
        );
      })}
    </nav>
  );
}
