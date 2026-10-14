"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import type { View } from "@/lib/domain/view";
import { routes } from "@/lib/routes";
import { Popover } from "@/features/grid/editors/Popover";
import { useOutsidePointerDown } from "@/features/grid/editors/useOutsidePointerDown";
import { request } from "@/features/grid/api";

/** "+" next to the view tabs: adds a grid view or a form, then opens it. */
export function NewViewButton({ baseId, tableId, viewCount }: { baseId: string; tableId: string; viewCount: number }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useOutsidePointerDown([buttonRef, menuRef], () => setOpen(false));

  async function create(kind: View["kind"]) {
    setOpen(false);
    try {
      const { view } = await request<{ view: View }>(`/api/tables/${tableId}/views`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind, name: kind === "form" ? "Form" : `Grid ${viewCount + 1}` }),
      });
      router.push(routes.view(baseId, tableId, view.id));
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't add the view");
    }
  }

  return (
    <>
      <button ref={buttonRef} type="button" aria-label="Add a view" aria-haspopup="menu" aria-expanded={open} className="rounded px-2 py-1 text-sm text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800" onClick={() => setOpen((value) => !value)}>
        +
      </button>
      {open && (
        <Popover anchor={buttonRef}>
          <div ref={menuRef} role="menu" className="py-1">
            <button type="button" role="menuitem" className="block w-full px-3 py-1.5 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800" onClick={() => void create("grid")}>
              Grid view
            </button>
            <button type="button" role="menuitem" className="block w-full px-3 py-1.5 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800" onClick={() => void create("form")}>
              Form
            </button>
          </div>
        </Popover>
      )}
      {error && (
        <span role="alert" className="text-xs text-red-600">
          {error}
        </span>
      )}
    </>
  );
}
