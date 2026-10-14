import { useEffect, useState } from "react";
import type { SelectOption } from "@/lib/domain/field";
import { searchRecords, type RecordOption } from "@/features/grid/api";

/** Shared look of the panel's small controls. */
export const controlClass =
  "h-7 rounded border border-zinc-300 bg-white px-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900 aria-invalid:border-red-500";
export const smallButtonClass = "rounded px-2 py-1 text-sm text-zinc-600 hover:bg-zinc-100 disabled:opacity-40 dark:text-zinc-300 dark:hover:bg-zinc-800";

function parseNumber(text: string): number | null {
  const normalized = text.trim().replace(",", ".");
  if (normalized === "") return null;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

/**
 * A number field that keeps what's being typed ("-", "1.") while the form holds a
 * number or null. The text follows the form only when the form changes from outside
 * (a reset, an operator change).
 */
export function NumberInput({ value, onChange, label, invalid }: { value: number | null; onChange: (value: number | null) => void; label: string; invalid?: boolean }) {
  const [text, setText] = useState(value === null ? "" : String(value));
  const [shown, setShown] = useState(value);
  if (value !== shown) {
    setShown(value);
    if (parseNumber(text) !== value) setText(value === null ? "" : String(value));
  }
  return (
    <input
      type="text"
      inputMode="decimal"
      aria-label={label}
      aria-invalid={invalid || undefined}
      className={`${controlClass} w-24`}
      value={text}
      onChange={(event) => {
        setText(event.target.value);
        const next = parseNumber(event.target.value);
        setShown(next);
        onChange(next);
      }}
    />
  );
}

/** Select options as toggle chips: "is any of" picks several. */
export function OptionPicker({ options, value, onChange, label }: { options: SelectOption[]; value: string[]; onChange: (value: string[]) => void; label: string }) {
  return (
    <div role="group" aria-label={label} className="flex max-h-24 max-w-md flex-wrap gap-1 overflow-auto">
      {options.map((option) => {
        const on = value.includes(option.id);
        return (
          <button
            key={option.id}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(on ? value.filter((id) => id !== option.id) : [...value, option.id])}
            className={`rounded-full border px-2 text-xs leading-5 ${on ? "border-transparent" : "border-zinc-300 text-zinc-500 dark:border-zinc-700"}`}
            style={on ? { backgroundColor: `${option.color}22`, color: option.color } : undefined}
          >
            {option.label}
          </button>
        );
      })}
      {options.length === 0 && <span className="text-xs text-zinc-400">This field has no options</span>}
    </div>
  );
}

const SEARCH_DELAY_MS = 200;

/** Linked records for "has any of": search the linked table by primary value, picked records as chips. */
export function RecordPicker({
  tableId,
  value,
  onChange,
  labelOf,
  label,
}: {
  tableId: string;
  value: string[];
  onChange: (value: string[]) => void;
  labelOf: (rowId: string) => string | undefined;
  label: string;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<RecordOption[]>([]);
  const [labels, setLabels] = useState<Record<string, string>>({});

  useEffect(() => {
    if (query.trim() === "") return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      searchRecords(tableId, query, controller.signal).then(setResults, () => undefined);
    }, SEARCH_DELAY_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [tableId, query]);

  const shown = query.trim() === "" ? [] : results.filter((record) => !value.includes(record.id));
  return (
    <div className="relative flex flex-wrap items-center gap-1">
      {value.map((id) => (
        <span key={id} className="flex items-center gap-1 rounded-full bg-blue-50 px-2 text-xs leading-5 text-blue-700 dark:bg-blue-950 dark:text-blue-300">
          {labels[id] ?? labelOf(id) ?? id}
          <button type="button" aria-label={`Remove ${labels[id] ?? labelOf(id) ?? id}`} onClick={() => onChange(value.filter((candidate) => candidate !== id))}>
            ×
          </button>
        </span>
      ))}
      <input type="search" aria-label={label} placeholder="Search records" className={`${controlClass} w-40`} value={query} onChange={(event) => setQuery(event.target.value)} />
      {shown.length > 0 && (
        <ul role="listbox" aria-label={`${label} results`} className="absolute top-8 left-0 z-10 max-h-48 w-64 overflow-auto rounded-md border border-zinc-200 bg-white py-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
          {shown.map((record) => (
            <li key={record.id} role="option" aria-selected={false}>
              <button
                type="button"
                className="block w-full truncate px-2 py-1 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800"
                onClick={() => {
                  setLabels((current) => ({ ...current, [record.id]: record.label }));
                  onChange([...value, record.id]);
                  setQuery("");
                }}
              >
                {record.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
