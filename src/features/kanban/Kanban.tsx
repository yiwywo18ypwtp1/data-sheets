"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { KanbanResponse } from "@/lib/domain/api";
import type { CellValue } from "@/lib/domain/cell";
import { createCoercer } from "@/lib/coerce/coerce";
import type { Field } from "@/lib/domain/field";
import { usesRelativeDates, type FilterGroup } from "@/lib/domain/filter";
import { newId } from "@/lib/domain/ids";
import { kanbanFields, visibleFields, type View, type ViewQuery } from "@/lib/domain/view";
import { createCellFormatter } from "@/lib/format";
import { download, exportCsvUrl, getClientId, sendRowBatch, type RowQuery } from "@/features/grid/api";
import { connectRealtime, type RealtimeStatus } from "@/features/grid/realtime";
import { Toasts } from "@/features/grid/Toasts";
import { pushToast } from "@/features/grid/toastStore";
import { useSavedView } from "@/features/grid/useSavedView";
import { useViewerLocale } from "@/features/grid/useViewerLocale";
import { emitCommentEvent } from "@/features/records/commentBus";
import { notifyMention } from "@/features/records/mentions";
import { RecordPanel, recordFields } from "@/features/records/RecordPanel";
import { useOpenRecord } from "@/features/records/useOpenRecord";
import { ViewPanel } from "@/features/view-panel/ViewPanel";
import { withOfflineCopy } from "@/features/offline/windowCache";
import { fetchKanban } from "./api";
import { appendCards, findCard, moveCard, neighbourKey, replaceCard, type Columns } from "./board";
import { KanbanColumn } from "./KanbanColumn";

type KanbanProps = {
  tableId: string;
  tableName: string;
  fields: Field[];
  primaryFieldId: string;
  view: View;
  viewVersion: number;
  /** The first page of every column, rendered on the server; null when the board has no field to stack by. */
  initial: KanbanResponse | null;
  linkFilter: FilterGroup | null;
  linkFilterError: string | null;
  canEdit: boolean;
  currentUser: { id: string; name: string };
  initialRecordId: string | null;
};

const PAGE = 50;
/** After a move is confirmed, the board reloads once things settle, to put the card in its sorted place. */
const RELOAD_DELAY_MS = 600;

type Move = { rowId: string; from: string | null; to: string | null };

/**
 * A kanban view: one column per option of a single select field (and one for "no value"),
 * cards in the view's filter and sort order. Dragging a card to another column, or
 * Alt+←/→ on a focused card, sets the field: optimistic, then confirmed by the server.
 * Cmd+Z undoes the last move. Other people's changes reload the board; comments and
 * mentions work as in the grid. Columns load 50 cards at a time.
 */
export function Kanban({ tableId, tableName, fields, primaryFieldId, view, viewVersion, initial, linkFilter, linkFilterError, canEdit, currentUser, initialRecordId }: KanbanProps) {
  const router = useRouter();
  const { locale, timeZone } = useViewerLocale();
  const savedView = useSavedView(view, viewVersion);
  const fieldId = savedView.view.kanban?.fieldId ?? null;
  const stackField = fields.find((field) => field.id === fieldId && field.type === "singleSelect");

  const [columns, setColumns] = useState<Columns>(initial?.columns ?? []);
  const [labels, setLabels] = useState<Record<string, string>>(initial?.linkedLabels ?? {});
  const [filterAndSorts, setFilterAndSorts] = useState<Pick<RowQuery, "filter" | "sorts">>({ filter: linkFilter ?? view.filter, sorts: view.sorts });
  // The server rendered the board in UTC; the viewer's zone only changes the rows for "today"-style filters.
  const relative = usesRelativeDates(filterAndSorts.filter);
  const query = useMemo(() => ({ ...filterAndSorts, timeZone: relative ? timeZone : "UTC" }), [filterAndSorts, relative, timeZone]);
  const [panelOpen, setPanelOpen] = useState(linkFilter !== null || linkFilterError !== null);
  const [status, setStatus] = useState<RealtimeStatus>("connecting");
  /** Set while the board shows the copy saved on this device (the server can't be reached). */
  const [copyAt, setCopyAt] = useState<Date | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null | undefined>(undefined);
  const [record, setRecord] = useOpenRecord(initialRecordId ? { rowId: initialRecordId, tab: "comments", fieldId: null } : null);
  const focusAfterMove = useRef<string | null>(null);
  const undoStack = useRef<Move[]>([]);
  const redoStack = useRef<Move[]>([]);

  // Latest values for callbacks that outlive a render (timers, the realtime stream).
  const latest = useRef({ columns, query, fieldId });
  useEffect(() => {
    latest.current = { columns, query, fieldId };
  });
  const pendingWrites = useRef(0);
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generation = useRef(0);

  /** Loads the columns again (as many cards per column as are shown now), unless a move is still on its way. */
  const reload = useCallback(async () => {
    const { query: current, fieldId: stackBy, columns: shown } = latest.current;
    if (!stackBy) return;
    if (pendingWrites.current > 0) return scheduleReload();
    const limit = Math.min(500, Math.max(PAGE, ...shown.map((column) => column.rows.length)));
    const ticket = ++generation.current;
    try {
      const response = await withOfflineCopy(currentUser.id, tableId, JSON.stringify(["kanban", current, stackBy]), () => fetchKanban(tableId, current, stackBy, { limit }), {
        onCopy: setCopyAt,
        onFresh: () => setCopyAt(null),
      });
      if (ticket !== generation.current || pendingWrites.current > 0) return;
      setColumns(response.columns);
      setLabels((known) => ({ ...known, ...response.linkedLabels }));
    } catch (cause) {
      if (ticket === generation.current) setAnnouncement(cause instanceof Error ? `Couldn't load the board: ${cause.message}` : "Couldn't load the board");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scheduleReload is hoisted below and only reads refs
  }, [tableId, currentUser.id]);
  function scheduleReload(delay = RELOAD_DELAY_MS) {
    if (reloadTimer.current) clearTimeout(reloadTimer.current);
    reloadTimer.current = setTimeout(() => void reload(), delay);
  }
  useEffect(() => () => {
    if (reloadTimer.current) clearTimeout(reloadTimer.current);
  }, []);

  // A new filter, sort, stacking field or time zone: a fresh board.
  const queryKey = JSON.stringify([query, fieldId]);
  const firstQuery = useRef(queryKey);
  useEffect(() => {
    if (queryKey === firstQuery.current) return;
    firstQuery.current = queryKey;
    void reload();
  }, [queryKey, reload]);
  // Others' changes: the board reloads (coalesced); schema changes reload the page.
  useEffect(() => {
    return connectRealtime(tableId, {
      onStatus: setStatus,
      onReset: () => scheduleReload(0),
      onPresence: () => undefined,
      onEvent: (event) => {
        if (event.origin.clientId === getClientId()) return;
        if (event.kind === "rows" || event.kind === "reload") scheduleReload(200);
        else if (event.kind === "schema") {
          pushToast({ message: `${event.origin.name} changed the fields of this table.` });
          router.refresh();
        } else if (event.kind === "view" && event.view.id === view.id) {
          savedView.applyRemote(event.view, event.version);
          pushToast({ message: `${event.origin.name} saved changes to this view.` });
        } else if (event.kind === "comment") {
          emitCommentEvent(event);
          if (event.comment?.mentions.includes(currentUser.id)) notifyMention(event, (rowId) => setRecord({ rowId, tab: "comments", fieldId: null }));
        }
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one stream per board; handlers read refs and stable setters
  }, [tableId, view.id]);

  const formatters = useMemo(() => {
    const labelOf = (id: string) => labels[id];
    return new Map(fields.map((field) => [field.id, createCellFormatter(field, { locale, timeZone, labelOf })]));
  }, [fields, labels, locale, timeZone]);
  const shownFields = useMemo(() => visibleFields(fields, primaryFieldId, savedView.view), [fields, primaryFieldId, savedView.view]);
  const cardFields = useMemo(() => shownFields.filter((field) => field.id !== primaryFieldId && field.id !== fieldId), [shownFields, primaryFieldId, fieldId]);
  const options = stackField?.type === "singleSelect" ? stackField.options : [];
  const titleOf = (key: string | null) => (key === null ? `No ${stackField?.name ?? "value"}` : (options.find((option) => option.id === key)?.label ?? "Unknown option"));

  /** Sets the stacking field of a card; `record` false for undo/redo, which manage the stacks themselves. */
  async function move(rowId: string, to: string | null, record = true) {
    if (!canEdit || !fieldId) return;
    const found = findCard(columns, rowId);
    const next = moveCard(columns, rowId, fieldId, to);
    if (!found || !next) return;
    const from = columns[found.column].key;
    setColumns(next);
    if (record) {
      undoStack.current.push({ rowId, from, to });
      redoStack.current = [];
    }
    const title = formatters.get(primaryFieldId)?.(found.row.values[primaryFieldId]) || "the record";
    setAnnouncement(`Moved ${title} to ${titleOf(to)}`);
    pendingWrites.current++;
    try {
      const [result] = await sendRowBatch(tableId, [{ op: "update", rowId, values: { [fieldId]: to }, rev: found.row.rev }]);
      if (result?.ok && result.row) setColumns((current) => replaceCard(current, result.row!));
      else {
        pushToast({ tone: "warning", message: `Couldn't move ${title}: ${result && !result.ok ? (result.error.fieldErrors?.[fieldId] ?? result.error.message) : "no answer"}` });
        undoStack.current = undoStack.current.filter((entry) => entry.rowId !== rowId);
      }
    } catch (cause) {
      pushToast({ tone: "warning", message: `Couldn't move ${title}: ${cause instanceof Error ? cause.message : "request failed"}` });
    } finally {
      pendingWrites.current--;
      scheduleReload();
    }
  }

  function undoOrRedo(redo: boolean) {
    const entry = (redo ? redoStack.current : undoStack.current).pop();
    if (!entry) return setAnnouncement(redo ? "Nothing to redo" : "Nothing to undo");
    (redo ? undoStack.current : redoStack.current).push(entry);
    focusAfterMove.current = entry.rowId;
    void move(entry.rowId, redo ? entry.to : entry.from, false);
  }

  // A card moved with the keyboard keeps the focus in its new column.
  useEffect(() => {
    const id = focusAfterMove.current;
    if (!id) return;
    focusAfterMove.current = null;
    document.querySelector<HTMLElement>(`[data-card="${id}"]`)?.focus();
  }, [columns]);

  const onCardKey = (event: KeyboardEvent<HTMLButtonElement>, rowId: string) => {
    const horizontal = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    if (horizontal && event.altKey) {
      event.preventDefault();
      const to = neighbourKey(columns, rowId, horizontal);
      if (to === undefined) return;
      focusAfterMove.current = rowId;
      return void move(rowId, to);
    }
    // Arrows walk the board: up/down within a column, left/right to the next column's first card.
    const found = findCard(columns, rowId);
    if (!found) return;
    let target: string | undefined;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") target = columns[found.column].rows[found.index + (event.key === "ArrowDown" ? 1 : -1)]?.id;
    else if (horizontal) {
      for (let column = found.column + horizontal; column >= 0 && column < columns.length && !target; column += horizontal) {
        target = columns[column].rows[Math.min(found.index, columns[column].rows.length - 1)]?.id;
      }
    } else return;
    event.preventDefault();
    if (target) document.querySelector<HTMLElement>(`[data-card="${target}"]`)?.focus();
  };

  async function showMore(key: string | null) {
    if (!fieldId) return;
    const column = columns.find((candidate) => candidate.key === key);
    try {
      const response = await fetchKanban(tableId, query, fieldId, { limit: PAGE, column: key, offset: column?.rows.length ?? 0 });
      const loaded = response.columns[0];
      if (loaded) setColumns((current) => appendCards(current, key, loaded.rows, loaded.count));
      setLabels((known) => ({ ...known, ...response.linkedLabels }));
    } catch (cause) {
      pushToast({ tone: "warning", message: cause instanceof Error ? cause.message : "Couldn't load more records" });
    }
  }

  async function add(key: string | null, text: string) {
    if (!fieldId) return;
    const primary = fields.find((field) => field.id === primaryFieldId);
    const values: Record<string, CellValue> = { [fieldId]: key };
    if (primary && text.trim()) {
      const coerced = createCoercer(primary, { locale, timeZone })(text);
      if (!coerced.ok) return pushToast({ tone: "warning", message: coerced.error });
      values[primary.id] = coerced.value;
    }
    try {
      const [result] = await sendRowBatch(tableId, [{ op: "create", rowId: newId("row"), values }]);
      if (!result?.ok) pushToast({ tone: "warning", message: `Couldn't add the record: ${result?.ok === false ? result.error.message : "no answer"}` });
      else setAnnouncement(`Added a record to ${titleOf(key)}`);
    } catch (cause) {
      pushToast({ tone: "warning", message: cause instanceof Error ? cause.message : "Couldn't add the record" });
    }
    scheduleReload(0);
  }

  async function restore(rowId: string, fieldIdToRestore: string, value: CellValue) {
    const found = findCard(columns, rowId);
    try {
      const [result] = await sendRowBatch(tableId, [{ op: "update", rowId, values: { [fieldIdToRestore]: value }, rev: found?.row.rev ?? 0 }]);
      if (!result?.ok) pushToast({ tone: "warning", message: `Couldn't restore: ${result?.ok === false ? result.error.message : "no answer"}` });
    } catch (cause) {
      pushToast({ tone: "warning", message: cause instanceof Error ? cause.message : "Couldn't restore" });
    }
    scheduleReload(0);
  }

  const applyQuery = useCallback(({ filter, sorts }: ViewQuery) => {
    setFilterAndSorts((current) => (JSON.stringify([filter, sorts]) === JSON.stringify([current.filter, current.sorts]) ? current : { filter, sorts }));
  }, []);
  const [panelStatus, setPanelStatus] = useState({ dirty: false, active: view.sorts.length, fieldIds: "" });
  const total = columns.reduce((sum, column) => sum + column.count, 0);
  const openRow = record ? findCard(columns, record.rowId)?.row : undefined;
  const live = status === "live";
  const buttonClass = "rounded px-2 py-1 text-sm text-zinc-700 hover:bg-zinc-100 disabled:opacity-40 dark:text-zinc-200 dark:hover:bg-zinc-800";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-zinc-200 px-3 dark:border-zinc-800">
        <label className="flex items-center gap-1.5 text-sm text-zinc-600 dark:text-zinc-300">
          Stacked by
          <select
            value={fieldId ?? ""}
            disabled={!canEdit}
            onChange={(event) => {
              savedView.save({ kanban: { fieldId: event.target.value } }).catch((cause: unknown) => pushToast({ tone: "warning", message: cause instanceof Error ? cause.message : "Couldn't save the view" }));
            }}
            className="rounded border border-zinc-300 bg-white px-1.5 py-0.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          >
            {!stackField && <option value="">Choose a field…</option>}
            {kanbanFields(fields).map((field) => (
              <option key={field.id} value={field.id}>
                {field.name}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className={`${buttonClass} ${panelOpen ? "bg-zinc-100 dark:bg-zinc-800" : ""}`} aria-expanded={panelOpen} onClick={() => setPanelOpen((open) => !open)}>
          Filter &amp; sort{panelStatus.active > 0 ? ` · ${panelStatus.active}` : ""}
          {panelStatus.dirty && <span aria-label="unsaved changes" className="ml-1 inline-block size-1.5 rounded-full bg-amber-500 align-middle" />}
        </button>
        <button type="button" className={buttonClass} onClick={() => download(exportCsvUrl(tableId, view.id, { ...query, timeZone }))}>
          Export CSV
        </button>
        <span className="ml-auto text-xs text-zinc-500">{total.toLocaleString()} records</span>
        <span role="status" title={copyAt ? `Cards saved on this device ${copyAt.toLocaleString()}` : undefined} className={`flex items-center gap-1.5 text-xs ${live && !copyAt ? "text-zinc-500" : "text-amber-700 dark:text-amber-400"}`}>
          <span aria-hidden className={`size-2 rounded-full ${live && !copyAt ? "bg-green-500" : "animate-pulse bg-amber-500"}`} />
          {copyAt ? "Offline · saved copy" : live ? "Live" : status === "connecting" ? "Connecting…" : "Reconnecting…"}
        </span>
      </div>
      <ViewPanel
        open={panelOpen}
        fields={fields}
        saved={savedView.view}
        save={canEdit ? savedView.save : null}
        onApply={applyQuery}
        linkFilter={linkFilter}
        linkFilterError={linkFilterError}
        onStatusChange={setPanelStatus}
        labelOf={(id) => labels[id]}
        grouping={false}
      />
      <div role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>
      {!stackField ? (
        <p className="p-6 text-sm text-zinc-600 dark:text-zinc-300">
          {kanbanFields(fields).length === 0
            ? `${tableName} has no single select field to stack a board by.`
            : canEdit
              ? "Choose the single select field whose options become the columns."
              : "This board's field was removed; an editor can choose another one."}
        </p>
      ) : (
        <div
          aria-label={`${tableName} board, stacked by ${stackField.name}`}
          role="group"
          className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-3"
          onKeyDown={(event) => {
            const mod = event.metaKey || event.ctrlKey;
            if (!canEdit || !mod || event.key.toLowerCase() !== "z" || event.target instanceof HTMLInputElement) return;
            event.preventDefault();
            undoOrRedo(event.shiftKey);
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(undefined);
          }}
        >
          {columns.map((column) => (
            <KanbanColumn
              key={column.key ?? ""}
              column={column}
              title={titleOf(column.key)}
              color={options.find((option) => option.id === column.key)?.color ?? null}
              primaryFieldId={primaryFieldId}
              cardFields={cardFields}
              formatters={formatters}
              canEdit={canEdit}
              dropTarget={dragging !== null && over === column.key}
              dragging={dragging !== null}
              onDragOverColumn={setOver}
              onDropCard={(rowId, key) => {
                setDragging(null);
                setOver(undefined);
                void move(rowId, key);
              }}
              onDragCard={(rowId) => {
                setDragging(rowId);
                if (!rowId) setOver(undefined);
              }}
              onOpen={(rowId) => setRecord({ rowId, tab: "comments", fieldId: null })}
              onCardKey={onCardKey}
              onShowMore={(key) => void showMore(key)}
              onAdd={canEdit ? (key, text) => void add(key, text) : null}
            />
          ))}
        </div>
      )}
      <Toasts />
      {record && (
        <RecordPanel
          tableId={tableId}
          record={record}
          row={openRow}
          fields={recordFields(fields, shownFields)}
          primaryFieldId={primaryFieldId}
          currentUserId={currentUser.id}
          locale={locale}
          timeZone={timeZone}
          labelOf={(id) => labels[id]}
          onRestore={canEdit ? (field, value) => void restore(record.rowId, field, value) : null}
          onChange={setRecord}
          onClose={() => {
            const id = record.rowId;
            setRecord(null);
            document.querySelector<HTMLElement>(`[data-card="${id}"]`)?.focus();
          }}
        />
      )}
    </div>
  );
}
