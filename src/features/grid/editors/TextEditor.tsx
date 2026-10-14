import { useRef, useState, type KeyboardEvent } from "react";
import { createCoercer } from "@/lib/coerce/coerce";
import type { Field } from "@/lib/domain/field";
import { useGridEditing, type CommitMove } from "../GridEditingContext";
import { Popover } from "./Popover";
import { useOutsidePointerDown } from "./useOutsidePointerDown";

type TextEditorProps = { field: Field; initialText: string };

function hintFor(field: Field, locale: string, timeZone: string): string | null {
  if (field.type !== "date") return null;
  const sample = new Intl.DateTimeFormat(locale, { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.UTC(2026, 2, 31)));
  return field.includeTime ? `e.g. ${sample} 14:30 · time in ${field.timeZone ?? timeZone}` : `e.g. ${sample}`;
}

/**
 * Text input for text, number, currency, email, url and date cells. The typed text is
 * parsed with the same coercer as paste and import, in the viewer's locale; an
 * invalid value is not saved: the editor stays open and shows why.
 */
export function TextEditor({ field, initialText }: TextEditorProps) {
  const { locale, timeZone, commit, cancel } = useGridEditing();
  const [text, setText] = useState(initialText);
  const [error, setError] = useState<string | null>(null);
  // Built once per editor: the coercer prepares Intl formatters and option maps.
  const [coerce] = useState(() => createCoercer(field, { locale, timeZone }));
  const inputRef = useRef<HTMLInputElement>(null);
  const hint = hintFor(field, locale, timeZone);

  function tryCommit(move: CommitMove): boolean {
    const result = coerce(text);
    if (!result.ok) {
      setError(result.error);
      return false;
    }
    commit(result.value, move);
    return true;
  }

  // Clicking elsewhere saves a valid value and drops an invalid one, so it never blocks the grid.
  useOutsidePointerDown([inputRef], () => {
    if (!tryCommit("none")) cancel();
  });

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    // Keys typed into the editor must not also move the grid's selection.
    event.stopPropagation();
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      tryCommit(event.shiftKey ? "up" : "down");
    } else if (event.key === "Tab") {
      event.preventDefault();
      tryCommit(event.shiftKey ? "left" : "right");
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    }
  }

  return (
    <>
      <input
        ref={inputRef}
        autoFocus
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setError(null);
        }}
        onKeyDown={onKeyDown}
        // Keeps the caret at the end when editing starts with a typed character.
        onFocus={(event) => event.target.setSelectionRange(event.target.value.length, event.target.value.length)}
        aria-label={`Edit ${field.name}`}
        aria-invalid={error !== null}
        className={`h-full w-full bg-transparent px-0 outline-none ${field.type === "number" || field.type === "currency" ? "text-right tabular-nums" : ""}`}
      />
      {(error || hint) && (
        <Popover anchor={inputRef} className="px-2 py-1 text-xs">
          {error ? (
            <span role="alert" className="text-red-600">
              {error}
            </span>
          ) : (
            <span className="text-zinc-500">{hint}</span>
          )}
        </Popover>
      )}
    </>
  );
}
