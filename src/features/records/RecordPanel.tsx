"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { CellValue } from "@/lib/domain/cell";
import type { Field } from "@/lib/domain/field";
import type { Row } from "@/lib/domain/row";
import { createCellFormatter } from "@/lib/format";
import { ApiRequestError } from "@/features/grid/api";
import { fetchRecord } from "./api";
import { CellHistory } from "./CellHistory";
import { Comments } from "./Comments";

export type RecordTab = "comments" | "history";

/** Which record the panel shows, and how it was opened (from a cell: that cell's history). */
export type OpenRecord = { rowId: string; tab: RecordTab; fieldId: string | null };

type RecordPanelProps = {
  tableId: string;
  record: OpenRecord;
  /** The record as the caller holds it (with unsaved edits); undefined when it isn't loaded there. */
  row: Row | undefined;
  /** Fields in display order. */
  fields: Field[];
  primaryFieldId: string;
  /** Whose comments can be deleted here, and whose mentions are highlighted. */
  currentUserId: string;
  locale: string;
  timeZone: string;
  labelOf: (rowId: string) => string | undefined;
  onRestore: ((fieldId: string, value: CellValue) => void) | null;
  onChange: (record: OpenRecord) => void;
  onClose: () => void;
};

/**
 * A side panel with one record: its values, comments, and the history of its cells. Opened from the
 * grid (the row's ⤢ button, Shift+Enter, the cell menu), from a kanban card, or by a link
 * (`?record=<rowId>`). The record usually comes from the caller, who keeps it current
 * (realtime, own edits); a record that isn't loaded there is fetched once.
 */
export function RecordPanel({ tableId, record, row, fields, primaryFieldId, currentUserId, locale, timeZone, labelOf, onRestore, onChange, onClose }: RecordPanelProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLElement>(null);
  const [fetched, setFetched] = useState<{ rowId: string; row: Row | null; labels: Record<string, string>; error: string | null } | null>(null);

  const needsFetch = row === undefined && fetched?.rowId !== record.rowId;
  useEffect(() => {
    if (!needsFetch) return;
    const controller = new AbortController();
    fetchRecord(tableId, record.rowId, controller.signal).then(
      (response) => setFetched({ rowId: record.rowId, row: response.row, labels: response.linkedLabels, error: null }),
      (cause: unknown) => {
        if (controller.signal.aborted) return;
        const message = cause instanceof ApiRequestError && cause.status === 404 ? "This record doesn't exist any more (it may have been deleted)." : "Couldn't load the record.";
        setFetched({ rowId: record.rowId, row: null, labels: {}, error: message });
      },
    );
    return () => controller.abort();
  }, [needsFetch, tableId, record.rowId]);

  const shown = row ?? (fetched?.rowId === record.rowId ? fetched.row : null) ?? undefined;
  const fetchedLabels = fetched?.labels;
  const labelOfAny = useMemo(() => (id: string) => labelOf(id) ?? fetchedLabels?.[id], [labelOf, fetchedLabels]);
  const formatters = useMemo(
    () => new Map(fields.map((field) => [field.id, createCellFormatter(field, { locale, timeZone, labelOf: labelOfAny })])),
    [fields, locale, timeZone, labelOfAny],
  );

  // Focus moves into the panel when it opens, so Escape and Tab work in it right away.
  useEffect(() => panelRef.current?.focus(), [record.rowId]);

  const primary = fields.find((field) => field.id === primaryFieldId);
  const title = shown && primary ? formatters.get(primary.id)?.(shown.values[primary.id]) || "Unnamed record" : "Record";
  const error = fetched?.rowId === record.rowId ? fetched.error : null;

  return (
    <aside
      ref={panelRef}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.preventDefault();
          onClose();
        }
      }}
      className="fixed inset-y-0 right-0 z-40 flex w-[440px] max-w-full flex-col border-l border-zinc-200 bg-white shadow-xl outline-none dark:border-zinc-800 dark:bg-zinc-950"
    >
      <header className="flex items-center gap-2 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <h2 id={titleId} className="min-w-0 flex-1 truncate font-semibold">
          {title}
        </h2>
        <button type="button" aria-label="Close the record" className="rounded px-2 py-1 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800" onClick={onClose}>
          ✕
        </button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col">
        {error ? (
          <p role="alert" className="p-4 text-sm text-amber-700 dark:text-amber-400">
            {error}
          </p>
        ) : (
          <div className="max-h-[38vh] shrink-0 overflow-auto border-b border-zinc-200 dark:border-zinc-800">
            <dl className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-x-3 gap-y-1.5 px-4 py-3 text-sm">
              {fields.map((field) => (
                <div key={field.id} className="contents">
                  <dt className="truncate text-zinc-500">
                    <button
                      type="button"
                      title={`History of ${field.name}`}
                      className={`max-w-full truncate text-left hover:text-blue-600 ${record.fieldId === field.id ? "font-medium text-blue-600" : ""}`}
                      onClick={() => onChange({ ...record, tab: "history", fieldId: field.id })}
                    >
                      {field.name}
                    </button>
                  </dt>
                  <dd className="truncate">{shown ? formatters.get(field.id)?.(shown.values[field.id]) || <span className="text-zinc-300 dark:text-zinc-600">—</span> : "…"}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}

        <div role="tablist" aria-label="Record" className="flex shrink-0 gap-1 border-b border-zinc-200 px-4 pt-2 dark:border-zinc-800">
          {(["comments", "history"] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              id={`${titleId}-${tab}`}
              aria-selected={record.tab === tab}
              aria-controls={`${titleId}-${tab}-panel`}
              className={`-mb-px border-b-2 px-2 pb-1.5 text-sm ${record.tab === tab ? "border-blue-600 font-medium text-blue-700 dark:text-blue-300" : "border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"}`}
              onClick={() => onChange({ ...record, tab })}
            >
              {tab === "comments" ? "Comments" : "History"}
            </button>
          ))}
        </div>
        <section role="tabpanel" id={`${titleId}-${record.tab}-panel`} aria-labelledby={`${titleId}-${record.tab}`} className="min-h-0 flex-1 overflow-auto px-4 py-3">
          {record.tab === "comments" ? (
            <Comments tableId={tableId} rowId={record.rowId} currentUserId={currentUserId} locale={locale} timeZone={timeZone} />
          ) : (
            <CellHistory
              tableId={tableId}
              rowId={record.rowId}
              rev={shown?.rev}
              fields={fields}
              fieldId={record.fieldId}
              onFieldChange={(fieldId) => onChange({ ...record, fieldId })}
              currentValue={(fieldId) => shown?.values[fieldId]}
              locale={locale}
              timeZone={timeZone}
              labelOf={labelOfAny}
              onRestore={shown ? onRestore : null}
            />
          )}
        </section>
      </div>
    </aside>
  );
}
