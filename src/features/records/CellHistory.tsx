"use client";

import { useEffect, useMemo, useState } from "react";
import type { CellHistoryEntry } from "@/lib/domain/api";
import type { CellValue } from "@/lib/domain/cell";
import { isComputedField, type Field } from "@/lib/domain/field";
import { createCellFormatter } from "@/lib/format";
import { fetchCellHistory } from "./api";

type CellHistoryProps = {
  tableId: string;
  rowId: string;
  /** The record's revision: when it changes (anyone's write), the history is loaded again. */
  rev: number | undefined;
  fields: Field[];
  /** The field to show; null for all of the record's fields. */
  fieldId: string | null;
  onFieldChange: (fieldId: string | null) => void;
  /** The cell's current value, so "Restore" is offered only for an older value. */
  currentValue: (fieldId: string) => CellValue | undefined;
  locale: string;
  timeZone: string;
  labelOf: (rowId: string) => string | undefined;
  /** Writes an older value back (an undoable edit); null for viewers. */
  onRestore: ((fieldId: string, value: CellValue) => void) | null;
};

const sameValue = (a: CellValue | undefined, b: CellValue | undefined) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Who changed a cell, when, from what to what; newest first, with "Restore" on older values. */
export function CellHistory({ tableId, rowId, rev, fields, fieldId, onFieldChange, currentValue, locale, timeZone, labelOf, onRestore }: CellHistoryProps) {
  const [entries, setEntries] = useState<CellHistoryEntry[] | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  // Reloads from the newest entry whenever the record or the chosen field changes, or the record is written to.
  useEffect(() => {
    const controller = new AbortController();
    // A burst of writes (a paste) changes `rev` several times: wait for it to settle.
    const timer = setTimeout(() => {
      fetchCellHistory(tableId, rowId, { fieldId }, controller.signal).then(
        (response) => {
          setEntries(response.entries);
          setNext(response.next);
          setLabels(response.linkedLabels);
          setError(null);
        },
        (cause: unknown) => {
          if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Couldn't load the history");
        },
      );
    }, 150);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [tableId, rowId, fieldId, rev]);

  async function loadMore() {
    if (next === null) return;
    try {
      const response = await fetchCellHistory(tableId, rowId, { fieldId, before: next });
      setEntries((current) => [...(current ?? []), ...response.entries]);
      setNext(response.next);
      setLabels((current) => ({ ...current, ...response.linkedLabels }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't load the history");
    }
  }

  const fieldsById = useMemo(() => new Map(fields.map((field) => [field.id, field])), [fields]);
  const formatters = useMemo(() => {
    const labelOfAny = (id: string) => labels[id] ?? labelOf(id);
    return new Map(fields.map((field) => [field.id, createCellFormatter(field, { locale, timeZone, labelOf: labelOfAny })]));
  }, [fields, locale, timeZone, labels, labelOf]);
  const when = useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone }), [locale, timeZone]);
  const editable = fields.filter((field) => !isComputedField(field));

  const show = (entry: CellHistoryEntry, value: CellValue) => {
    const text = formatters.get(entry.fieldId)?.(value) ?? "";
    return text === "" ? <span className="text-zinc-400 italic">empty</span> : text;
  };

  return (
    <div className="flex flex-col gap-3">
      <label className="flex items-center gap-2 text-xs text-zinc-500">
        Field
        <select
          value={fieldId ?? ""}
          onChange={(event) => onFieldChange(event.target.value || null)}
          className="rounded border border-zinc-300 bg-white px-1.5 py-1 text-sm text-zinc-800 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
        >
          <option value="">All fields</option>
          {editable.map((field) => (
            <option key={field.id} value={field.id}>
              {field.name}
            </option>
          ))}
        </select>
      </label>

      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      {entries === null && !error && <p className="text-sm text-zinc-400">Loading…</p>}
      {entries?.length === 0 && (
        <p className="text-sm text-zinc-500">
          {fieldId ? "This cell hasn't been changed since the record was created." : "No changes since the record was created."}
        </p>
      )}

      <ol aria-label="Changes" className="flex flex-col gap-2">
        {entries?.map((entry) => {
          const field = fieldsById.get(entry.fieldId);
          if (!field) return null;
          const canRestore = onRestore !== null && !isComputedField(field) && !sameValue(currentValue(entry.fieldId), entry.after);
          return (
            <li key={entry.id} className="rounded border border-zinc-200 px-2.5 py-2 text-sm dark:border-zinc-800">
              <div className="flex items-baseline gap-2 text-xs text-zinc-500">
                <span className="font-medium text-zinc-700 dark:text-zinc-200">{entry.by.name}</span>
                {!fieldId && <span>· {field.name}</span>}
                <time dateTime={entry.at} className="ml-auto shrink-0">
                  {when.format(new Date(entry.at))}
                </time>
              </div>
              <div className="mt-1 flex flex-wrap items-baseline gap-x-2 break-words">
                <del className="text-zinc-500" aria-label="Before">
                  {show(entry, entry.before)}
                </del>
                <span aria-hidden className="text-zinc-400">
                  →
                </span>
                <ins className="no-underline" aria-label="After">
                  {show(entry, entry.after)}
                </ins>
                {canRestore && (
                  <button type="button" className="ml-auto text-xs text-blue-600 hover:underline" onClick={() => onRestore(entry.fieldId, entry.after)}>
                    Restore
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      {next !== null && (
        <button type="button" className="self-start text-sm text-blue-600 hover:underline" onClick={() => void loadMore()}>
          Show older changes
        </button>
      )}
    </div>
  );
}
