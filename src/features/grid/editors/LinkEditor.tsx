import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type { CellValue } from "@/lib/domain/cell";
import type { FieldOfType } from "@/lib/domain/field";
import { searchRecords, type RecordOption } from "../api";
import { useGridEditing } from "../GridEditingContext";
import { Popover } from "./Popover";
import { useOutsidePointerDown } from "./useOutsidePointerDown";

const SEARCH_DELAY_MS = 200;

type LinkEditorProps = { field: FieldOfType<"link">; value: CellValue | undefined; initialQuery: string };

/**
 * Picks records of the linked table by searching their primary value on the server.
 *
 * Races: every keystroke aborts the previous search (AbortController), and the
 * results of an aborted search are never applied, so a slow answer for "Ad" can't
 * overwrite the answer for "Ada".
 */
export function LinkEditor({ field, value, initialQuery }: LinkEditorProps) {
  const { store, commit, cancel } = useGridEditing();
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<RecordOption[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [chosen, setChosen] = useState<string[]>(Array.isArray(value) ? value : []);
  const [highlighted, setHighlighted] = useState(0);
  const anchorRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      searchRecords(field.targetTableId, query, controller.signal)
        .then((records) => {
          setResults(records);
          setHighlighted(0);
          setStatus("ready");
        })
        .catch(() => {
          if (!controller.signal.aborted) setStatus("error");
        });
    }, SEARCH_DELAY_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [field.targetTableId, query]);

  function save(ids: string[], move: "down" | "right" | "none" = "none") {
    // Labels of newly linked records, so the cell can show them before the server answers.
    store.addLabels(Object.fromEntries(results.filter((record) => ids.includes(record.id)).map((record) => [record.id, record.label])));
    commit(ids.length > 0 ? ids : null, move);
  }

  useOutsidePointerDown([anchorRef, panelRef], () => (field.multiple ? save(chosen) : cancel()));

  function pick(id: string) {
    if (!field.multiple) return save([id], "down");
    setChosen((current) => (current.includes(id) ? current.filter((candidate) => candidate !== id) : [...current, id]));
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    event.stopPropagation();
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setHighlighted((index) => Math.max(0, Math.min(results.length - 1, index + step)));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (field.multiple && (event.metaKey || event.ctrlKey)) save(chosen, "down");
      else if (results[highlighted]) pick(results[highlighted].id);
    } else if (event.key === "Tab") {
      event.preventDefault();
      save(chosen, "right");
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    }
  }

  const labelOf = (id: string) => results.find((record) => record.id === id)?.label ?? store.getLabel(id) ?? "…";

  return (
    <>
      {/* The anchor is a sibling, not a parent, of the popover: React attaches a parent's ref only
          after its children's layout effects run, so the popover couldn't measure a parent. */}
      <div ref={anchorRef} className="h-full w-full" />
      <Popover anchor={anchorRef}>
        <div ref={panelRef} className="w-72">
          {chosen.length > 0 && (
            <div className="flex flex-wrap gap-1 border-b border-zinc-200 p-2 dark:border-zinc-700">
              {chosen.map((id) => (
                <span key={id} className="flex items-center gap-1 rounded-full bg-blue-50 px-2 text-xs leading-5 text-blue-700 dark:bg-blue-950 dark:text-blue-300">
                  {labelOf(id)}
                  <button type="button" aria-label={`Unlink ${labelOf(id)}`} onClick={() => setChosen((current) => current.filter((candidate) => candidate !== id))}>
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          <input
            autoFocus
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setStatus("loading");
            }}
            onKeyDown={onKeyDown}
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-activedescendant={results[highlighted] ? `${listId}-${results[highlighted].id}` : undefined}
            aria-label={`Search records for ${field.name}`}
            placeholder="Search records"
            className="w-full border-b border-zinc-200 px-2 py-1.5 outline-none dark:border-zinc-700 dark:bg-zinc-900"
          />
          <ul id={listId} role="listbox" aria-busy={status === "loading"} className="max-h-60 overflow-auto py-1">
            {status === "error" && <li className="px-2 py-1 text-red-600">Search failed. Type again to retry.</li>}
            {status === "ready" && results.length === 0 && <li className="px-2 py-1 text-zinc-400">No records found</li>}
            {results.map((record, index) => (
              <li
                key={record.id}
                id={`${listId}-${record.id}`}
                role="option"
                aria-selected={chosen.includes(record.id)}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => pick(record.id)}
                onPointerEnter={() => setHighlighted(index)}
                className={`flex cursor-pointer items-center gap-2 px-2 py-1 ${index === highlighted ? "bg-zinc-100 dark:bg-zinc-800" : ""}`}
              >
                <span className="w-4 text-blue-600">{chosen.includes(record.id) ? "✓" : ""}</span>
                <span className="truncate">{record.label}</span>
              </li>
            ))}
          </ul>
          {field.multiple && <div className="border-t border-zinc-200 px-2 py-1 text-xs text-zinc-500 dark:border-zinc-700">Enter toggles · ⌘/Ctrl+Enter saves</div>}
        </div>
      </Popover>
    </>
  );
}
