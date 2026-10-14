import { useEffect, useState } from "react";
import { useFormContext, useWatch } from "react-hook-form";
import type { Field } from "@/lib/domain/field";
import { ApiRequestError } from "@/features/grid/api";
import { previewFieldChange, type ConversionPreview as Preview } from "./api";
import { ErrorText } from "./Dialog";

const PREVIEW_DELAY_MS = 400;

/** Whether saving `field` over `original` rewrites stored values (the server decides the same way). */
export function changesValues(original: Field, field: Field): boolean {
  if (original.type !== field.type) return true;
  if (original.type === "date" && field.type === "date") return original.includeTime !== field.includeTime;
  if (original.type === "link" && field.type === "link") return original.multiple && !field.multiple;
  if ((original.type === "singleSelect" || original.type === "multiSelect") && "options" in field) {
    return original.options.some((option) => !field.options.some((kept) => kept.id === option.id));
  }
  return false;
}

/**
 * Before a type change (or another change that rewrites values) is saved: how many of the
 * field's values will convert and how many will become empty, with examples, computed by
 * the server over every row (`PATCH ?preview=1`), while the user adjusts the settings.
 */
export function ConversionPreview({ tableId, original, locale, timeZone }: { tableId: string; original: Field; locale: string; timeZone: string }) {
  const { control } = useFormContext<Field>();
  const values = useWatch({ control }) as Field;
  const key = JSON.stringify(values);
  const [state, setState] = useState<{ key: string; preview: Preview } | { key: string; error: string } | null>(null);
  const relevant = changesValues(original, values);

  useEffect(() => {
    if (!relevant) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      previewFieldChange(tableId, JSON.parse(key) as Field, { locale, timeZone }, controller.signal).then(
        (preview) => setState({ key, preview }),
        (error) => {
          if (!controller.signal.aborted) setState({ key, error: error instanceof ApiRequestError ? error.message : "Couldn't preview the conversion" });
        },
      );
    }, PREVIEW_DELAY_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [tableId, key, relevant, locale, timeZone]);

  if (!relevant) return null;
  if (!state || state.key !== key) {
    return (
      <p aria-busy className="text-xs text-zinc-500">
        Checking how the values convert…
      </p>
    );
  }
  if ("error" in state) return <ErrorText>{state.error}</ErrorText>;
  const { preview } = state;
  return (
    <section aria-label="Conversion preview" className="flex flex-col gap-2 rounded border border-amber-200 bg-amber-50 p-2 text-sm dark:border-amber-800 dark:bg-amber-950">
      <p role="status">
        {preview.total === 0 ? (
          "The field has no values to convert."
        ) : (
          <>
            <strong>{preview.converted.toLocaleString()}</strong> of {preview.total.toLocaleString()} values will convert
            {preview.emptied > 0 && (
              <>
                ; <strong className="text-red-700 dark:text-red-400">{preview.emptied.toLocaleString()}</strong> can&apos;t and will become empty
              </>
            )}
            .
          </>
        )}
        {preview.newOptions.length > 0 && <> New options: {preview.newOptions.slice(0, 8).join(", ")}{preview.newOptions.length > 8 ? ` and ${preview.newOptions.length - 8} more` : ""}.</>}
      </p>
      {(preview.examples.length > 0 || preview.failures.length > 0) && (
        <table className="text-xs">
          <thead className="text-left text-zinc-500">
            <tr>
              <th className="pr-3 font-normal">Now</th>
              <th className="font-normal">After</th>
            </tr>
          </thead>
          <tbody>
            {preview.examples.map((example, i) => (
              <tr key={`e${i}`}>
                <td className="pr-3">{example.from}</td>
                <td>{example.to || <span className="text-zinc-400">empty</span>}</td>
              </tr>
            ))}
            {preview.failures.map((failure, i) => (
              <tr key={`f${i}`}>
                <td className="pr-3">{failure.from}</td>
                <td className="text-red-700 dark:text-red-400">empty ({failure.reason})</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
