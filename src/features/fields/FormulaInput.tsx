import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useController, useFormContext } from "react-hook-form";
import type { Field } from "@/lib/domain/field";
import { completionAt, highlight, type Completion, type TokenClass } from "./formulaAssist";

const TOKEN_CLASSES: Record<TokenClass, string> = {
  field: "text-blue-700 dark:text-blue-300",
  unknownField: "text-red-600 underline decoration-wavy",
  function: "text-purple-700 dark:text-purple-300",
  string: "text-green-700 dark:text-green-400",
  number: "text-amber-700 dark:text-amber-400",
  operator: "text-zinc-500",
  punctuation: "text-zinc-500",
  text: "",
};

// The textarea and the highlighted layer under it must lay text out identically.
const LAYOUT = "w-full rounded border px-2 py-1.5 font-mono text-sm leading-5 whitespace-pre-wrap break-words";

type FormulaInputProps = { fields: Field[]; invalid: boolean; describedBy: string };

/**
 * The formula textarea with syntax highlighting and completion. The text is drawn by a
 * highlighted <pre> under a transparent textarea (which keeps native editing, selection,
 * undo and IME). Completion: `{` lists fields, letters list functions; ↑/↓ choose,
 * Enter or Tab insert, Escape closes.
 */
export function FormulaInput({ fields, invalid, describedBy }: FormulaInputProps) {
  const { control } = useFormContext<Field>();
  const { field } = useController({ control, name: "expression" as never });
  const value = (field.value as string | undefined) ?? "";
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const layerRef = useRef<HTMLPreElement>(null);
  const [completion, setCompletion] = useState<Completion | null>(null);
  const [active, setActive] = useState(0);
  const listId = useId();
  // Where the caret goes after an inserted suggestion: set right after React writes the new text,
  // before the next keystroke (a later frame would let fast typing land in the wrong place).
  const pendingCaret = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (pendingCaret.current === null || !textareaRef.current) return;
    textareaRef.current.setSelectionRange(pendingCaret.current, pendingCaret.current);
    pendingCaret.current = null;
  }, [value]);

  const names = useMemo(() => new Set(fields.map((candidate) => candidate.name.toLowerCase())), [fields]);
  const tokens = useMemo(() => highlight(value, names), [value, names]);

  const updateCompletion = (text: string, caret: number) => {
    setCompletion(completionAt(text, caret, fields));
    setActive(0);
  };

  const accept = (index: number) => {
    const textarea = textareaRef.current;
    const item = completion?.items[index];
    if (!textarea || !completion || !item) return;
    const next = value.slice(0, completion.from) + item.insert + value.slice(completion.to);
    pendingCaret.current = completion.from + item.insert.length;
    field.onChange(next);
    setCompletion(null);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!completion) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((index) => (index + step + completion.items.length) % completion.items.length);
    } else if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      accept(active);
    } else if (event.key === "Escape") {
      event.preventDefault(); // closes the list, not the dialog
      setCompletion(null);
    }
  };

  return (
    <div className="relative">
      <pre ref={layerRef} aria-hidden className={`${LAYOUT} pointer-events-none absolute inset-0 m-0 overflow-hidden border-transparent`}>
        {tokens.map((token, i) => (
          <span key={i} className={TOKEN_CLASSES[token.kind]}>
            {token.text}
          </span>
        ))}
        {"\n"}
      </pre>
      <textarea
        ref={(element) => {
          textareaRef.current = element;
          field.ref(element);
        }}
        name={field.name}
        value={value}
        rows={3}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        aria-label="Formula"
        aria-invalid={invalid}
        aria-describedby={describedBy}
        aria-autocomplete="list"
        aria-controls={completion ? listId : undefined}
        aria-activedescendant={completion ? `${listId}-${active}` : undefined}
        placeholder='IF({Status} = "Done", {Price} * {Qty}, 0)'
        className={`${LAYOUT} relative resize-y border-zinc-300 bg-transparent text-transparent caret-zinc-900 selection:bg-blue-200 selection:text-transparent dark:border-zinc-700 dark:caret-zinc-100 ${invalid ? "border-red-500" : ""}`}
        onChange={(event) => {
          field.onChange(event.target.value);
          updateCompletion(event.target.value, event.target.selectionStart);
        }}
        onKeyDown={onKeyDown}
        onClick={(event) => updateCompletion(value, event.currentTarget.selectionStart)}
        onScroll={(event) => {
          if (layerRef.current) layerRef.current.scrollTop = event.currentTarget.scrollTop;
        }}
        onBlur={() => {
          field.onBlur();
          setCompletion(null);
        }}
      />
      {completion && (
        <ul id={listId} role="listbox" aria-label="Suggestions" className="absolute top-full left-0 z-10 mt-1 max-h-56 w-72 overflow-auto rounded-md border border-zinc-200 bg-white py-1 text-sm shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
          {completion.items.map((item, index) => (
            <li
              key={item.label}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === active}
              className={`flex cursor-pointer justify-between gap-2 px-2 py-1 ${index === active ? "bg-blue-50 dark:bg-blue-950" : ""}`}
              // Keep focus in the textarea, so the caret stays where the text is inserted.
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => accept(index)}
              onPointerEnter={() => setActive(index)}
            >
              <span className="truncate font-mono">{item.label}</span>
              <span className="text-xs text-zinc-400">{item.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
