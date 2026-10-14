import { useId, useRef, useState, type KeyboardEvent } from "react";
import type { CellValue } from "@/lib/domain/cell";
import type { FieldOfType } from "@/lib/domain/field";
import { useGridEditing } from "../GridEditingContext";
import { Popover } from "./Popover";
import { useOutsidePointerDown } from "./useOutsidePointerDown";

type SelectEditorProps = {
  field: FieldOfType<"singleSelect" | "multiSelect">;
  value: CellValue | undefined;
  initialQuery: string;
};

/**
 * Option picker with search. Single select: picking an option saves it. Multi select:
 * Enter or a click toggles options, Cmd/Ctrl+Enter, Tab or clicking outside saves.
 */
export function SelectEditor({ field, value, initialQuery }: SelectEditorProps) {
  const { commit, cancel } = useGridEditing();
  const multiple = field.type === "multiSelect";
  const [query, setQuery] = useState(initialQuery);
  const [chosen, setChosen] = useState<string[]>(Array.isArray(value) ? value : typeof value === "string" ? [value] : []);
  const [highlighted, setHighlighted] = useState(0);
  const anchorRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const options = field.options.filter((option) => option.label.toLowerCase().includes(query.trim().toLowerCase()));
  const save = (ids: string[], move: "down" | "right" | "none" = "none") =>
    commit(multiple ? (ids.length > 0 ? ids : null) : (ids[0] ?? null), move);

  useOutsidePointerDown([anchorRef, panelRef], () => (multiple ? save(chosen) : cancel()));

  function pick(id: string) {
    if (!multiple) return save([id], "down");
    setChosen((current) => (current.includes(id) ? current.filter((candidate) => candidate !== id) : [...current, id]));
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    event.stopPropagation();
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setHighlighted((index) => Math.max(0, Math.min(options.length - 1, index + step)));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (multiple && (event.metaKey || event.ctrlKey)) save(chosen, "down");
      else if (options[highlighted]) pick(options[highlighted].id);
    } else if (event.key === "Tab") {
      event.preventDefault();
      save(chosen, "right");
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    }
  }

  return (
    <>
      {/* The anchor is a sibling, not a parent, of the popover: React attaches a parent's ref only
          after its children's layout effects run, so the popover couldn't measure a parent. */}
      <div ref={anchorRef} className="h-full w-full" />
      <Popover anchor={anchorRef}>
        <div ref={panelRef}>
          <input
            autoFocus
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setHighlighted(0);
            }}
            onKeyDown={onKeyDown}
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-activedescendant={options[highlighted] ? `${listId}-${options[highlighted].id}` : undefined}
            aria-label={`Search ${field.name} options`}
            placeholder="Find an option"
            className="w-full border-b border-zinc-200 px-2 py-1.5 outline-none dark:border-zinc-700 dark:bg-zinc-900"
          />
          <ul id={listId} role="listbox" aria-multiselectable={multiple} className="max-h-60 overflow-auto py-1">
            {options.length === 0 && <li className="px-2 py-1 text-zinc-400">No matching options</li>}
            {options.map((option, index) => (
              <li
                key={option.id}
                id={`${listId}-${option.id}`}
                role="option"
                aria-selected={chosen.includes(option.id)}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => pick(option.id)}
                onPointerEnter={() => setHighlighted(index)}
                className={`flex cursor-pointer items-center gap-2 px-2 py-1 ${index === highlighted ? "bg-zinc-100 dark:bg-zinc-800" : ""}`}
              >
                <span className="w-4 text-blue-600">{chosen.includes(option.id) ? "✓" : ""}</span>
                <span className="rounded-full px-2 text-xs leading-5" style={{ backgroundColor: `${option.color}22`, color: option.color }}>
                  {option.label}
                </span>
              </li>
            ))}
          </ul>
          <div className="flex items-center justify-between border-t border-zinc-200 px-2 py-1 text-xs text-zinc-500 dark:border-zinc-700">
            <button type="button" className="hover:underline" onClick={() => save([], "none")}>
              Clear
            </button>
            {multiple && <span>Enter toggles · ⌘/Ctrl+Enter saves</span>}
          </div>
        </div>
      </Popover>
    </>
  );
}
