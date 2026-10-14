import Link from "next/link";
import type { View } from "@/lib/domain/view";
import { routes } from "@/lib/routes";

export function ViewTabs({ baseId, tableId, views, activeViewId }: { baseId: string; tableId: string; views: View[]; activeViewId: string }) {
  return (
    <nav aria-label="Views" className="flex gap-1">
      {views.map((view) => {
        const active = view.id === activeViewId;
        return (
          <Link
            key={view.id}
            href={routes.view(baseId, tableId, view.id)}
            aria-current={active ? "page" : undefined}
            className={`rounded px-2.5 py-1 text-sm ${
              active ? "bg-blue-50 font-medium text-blue-700 dark:bg-blue-950 dark:text-blue-300" : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
            }`}
          >
            {view.name}
          </Link>
        );
      })}
    </nav>
  );
}
