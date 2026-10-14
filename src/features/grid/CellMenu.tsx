import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useOutsidePointerDown } from "./editors/useOutsidePointerDown";

export type CellMenuItem = { label: string; shortcut?: string; onSelect: () => void };

/** The right-click menu of a cell, at the pointer. Arrow keys move between items, Escape closes it. */
export function CellMenu({ x, y, items, onClose }: { x: number; y: number; items: CellMenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useOutsidePointerDown([ref], onClose);
  useEffect(() => ref.current?.querySelector<HTMLButtonElement>("button")?.focus(), []);

  const left = Math.min(x, window.innerWidth - 240);
  const top = Math.min(y, window.innerHeight - items.length * 32 - 16);
  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label="Cell actions"
      className="fixed z-50 w-56 rounded-md border border-zinc-200 bg-white py-1 text-sm shadow-lg dark:border-zinc-700 dark:bg-zinc-900"
      style={{ left, top }}
      onKeyDown={(event) => {
        const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (event.key === "Escape") onClose();
        else if (event.key === "ArrowDown") buttons[(index + 1) % buttons.length]?.focus();
        else if (event.key === "ArrowUp") buttons[(index - 1 + buttons.length) % buttons.length]?.focus();
        else return;
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          className="flex w-full items-center px-3 py-1.5 text-left hover:bg-zinc-100 focus:bg-zinc-100 focus:outline-none dark:hover:bg-zinc-800 dark:focus:bg-zinc-800"
          onClick={() => {
            onClose();
            item.onSelect();
          }}
        >
          {item.label}
          {item.shortcut && <span className="ml-auto text-xs text-zinc-400">{item.shortcut}</span>}
        </button>
      ))}
    </div>,
    document.body,
  );
}
