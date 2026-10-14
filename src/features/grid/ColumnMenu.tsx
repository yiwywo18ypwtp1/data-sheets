import { useRef, useState } from "react";
import type { Field } from "@/lib/domain/field";
import { Popover } from "./editors/Popover";
import { useOutsidePointerDown } from "./editors/useOutsidePointerDown";

type ColumnMenuProps = {
  field: Field;
  /** The primary field is pinned first and can't be moved or hidden. */
  isPrimary: boolean;
  onMove: (direction: -1 | 1) => void;
  onHide: () => void;
};

/** The "⋯" menu of a column header. */
export function ColumnMenu({ field, isPrimary, onMove, onHide }: ColumnMenuProps) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useOutsidePointerDown([buttonRef, menuRef], () => setOpen(false));

  const item = (label: string, action: () => void) => (
    <button
      type="button"
      role="menuitem"
      className="block w-full px-3 py-1.5 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800"
      onClick={() => {
        action();
        setOpen(false);
      }}
    >
      {label}
    </button>
  );

  if (isPrimary) return null;
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label={`Options for ${field.name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape") setOpen(false);
        }}
        className="ml-auto shrink-0 rounded px-1 text-zinc-400 opacity-0 group-hover:opacity-100 hover:bg-zinc-200 focus:opacity-100 dark:hover:bg-zinc-700"
      >
        ⋯
      </button>
      {open && (
        <Popover anchor={buttonRef}>
          {/* React portals bubble events through the component tree: without this, Enter on a
              menu item would also reach the grid's keyboard handler and start editing. */}
          <div
            ref={menuRef}
            role="menu"
            aria-label={`${field.name} options`}
            className="py-1"
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Escape") setOpen(false);
            }}
          >
            {item("Move left", () => onMove(-1))}
            {item("Move right", () => onMove(1))}
            {item("Hide field", onHide)}
          </div>
        </Popover>
      )}
    </>
  );
}
