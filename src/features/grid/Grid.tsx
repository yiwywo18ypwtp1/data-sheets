"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { RowWindowResponse } from "@/lib/domain/api";
import type { CellValue } from "@/lib/domain/cell";
import type { Field } from "@/lib/domain/field";
import type { FilterGroup } from "@/lib/domain/filter";
import type { Row } from "@/lib/domain/row";
import type { View, ViewQuery } from "@/lib/domain/view";
import { createCellFormatter } from "@/lib/format";
import { DeleteFieldDialog } from "@/features/fields/DeleteFieldDialog";
import { FieldDialog, type BaseTable } from "@/features/fields/FieldDialog";
import { RecordPanel, recordFields, type RecordTab } from "@/features/records/RecordPanel";
import { useOpenRecord } from "@/features/records/useOpenRecord";
import { ViewPanel } from "@/features/view-panel/ViewPanel";
import { Outbox } from "@/features/offline/outbox";
import { withOfflineCopy } from "@/features/offline/windowCache";
import { download, exportCsvUrl, fetchRowWindow, getClientId, sendRowBatch } from "./api";
import { CellMenu } from "./CellMenu";
import { GridFooter } from "./GridFooter";
import { GridHeader } from "./GridHeader";
import { cellId, GridRow } from "./GridRow";
import { GridStore } from "./GridStore";
import { GridToolbar } from "./GridToolbar";
import { GroupHeaderRow } from "./GroupHeaderRow";
import { FOOTER_HEIGHT, gridColumns, GUTTER_WIDTH, HEADER_HEIGHT, moveField, ROW_HEIGHTS, setColumnWidth, setFieldHidden } from "./layout";
import { rangeOf, type CellPosition } from "./selection";
import { useCellEditing } from "./useCellEditing";
import { useClipboard } from "./useClipboard";
import { GridEditingContext } from "./GridEditingContext";
import { useGridSelection } from "./useGridSelection";
import { Toasts } from "./Toasts";
import { pushToast } from "./toastStore";
import { useGridStore } from "./useGridStore";
import { useRealtime } from "./useRealtime";
import { useSavedView } from "./useSavedView";
import { useViewerLocale } from "./useViewerLocale";
import { useViewLayout } from "./useViewLayout";

type GridProps = {
  tableId: string;
  /** Whether the current user may edit records. Only shapes the UI: the server checks again. */
  canEdit: boolean;
  /** Creators can add, edit and delete fields. */
  canChangeSchema: boolean;
  /** Every table of the base with its fields: link targets and lookups in the field dialog. */
  tables: BaseTable[];
  /** An unsaved filter from the URL (`?filter=`), applied on top of the saved view. */
  linkFilter: FilterGroup | null;
  linkFilterError: string | null;
  /** The table's CSV import page, for creators. */
  importHref: string | null;
  tableName: string;
  fields: Field[];
  primaryFieldId: string;
  view: View;
  /** The view's version, sent as If-Match when the column layout is saved. */
  viewVersion: number;
  initialWindow: RowWindowResponse;
  /** `?record=`: the record to open in the side panel. */
  initialRecordId: string | null;
  currentUser: { id: string; name: string };
};

/** Size assumed before the browser measures the container, so the server renders the first rows too. */
const INITIAL_RECT = { width: 1280, height: 800 };

/**
 * The virtualized grid. One scroll container, two virtualizers (rows and columns),
 * so only the cells on screen exist in the DOM: about 40 rows × 10 columns out of
 * 50 000 × 30. The header and footer stick vertically; the row numbers and the
 * primary column stick horizontally.
 *
 * Keyboard focus stays on the grid element itself; the active cell is announced
 * through `aria-activedescendant`, which works even though cells come and go as
 * they scroll in and out of view.
 */
export function Grid({ tableId, canEdit, canChangeSchema, tables, linkFilter, linkFilterError, importHref, tableName, fields, primaryFieldId, view, viewVersion, initialWindow, initialRecordId, currentUser }: GridProps) {
  const [store] = useState(() => {
    const created: GridStore = new GridStore({
      query: { filter: linkFilter ?? view.filter, sorts: view.sorts, groupBy: (view.groupBy ?? []).map((group) => group.fieldId), timeZone: "UTC" },
      fields,
      // Offline, windows come from the copy kept in IndexedDB (see offline/windowCache.ts).
      fetchWindow: (query, offset, limit, signal, withGroups) =>
        withOfflineCopy(tableId, JSON.stringify(["rows", query, offset, limit, withGroups === true]), () => fetchRowWindow(tableId, query, offset, limit, signal, withGroups), {
          onCopy: (savedAt) => created.setReadingCopy(savedAt),
          onFresh: () => created.setReadingCopy(null),
        }),
      sendBatch: (ops) => sendRowBatch(tableId, ops),
      initialWindow,
    });
    return created;
  });
  useEffect(() => () => store.dispose(), [store]);

  // Unsent edits are kept in IndexedDB, and edits an earlier session couldn't send are taken over.
  useEffect(() => {
    const outbox = new Outbox(tableId, `${getClientId()}:${tableId}:${crypto.randomUUID().slice(0, 8)}`);
    let active = true;
    store.setPersistence((edits) => outbox.save(edits));
    void outbox
      .start()
      .then(() => outbox.adoptOrphans())
      .then((edits) => {
        if (active && edits.length > 0) store.adoptEdits(edits);
      });
    return () => {
      active = false;
      store.setPersistence(null);
      outbox.dispose();
    };
  }, [store, tableId]);

  const { locale, timeZone } = useViewerLocale();
  useEffect(() => store.setTimeZone(timeZone), [store, timeZone]);

  const total = useGridStore(store, (state) => state.total);
  const layout = useGridStore(store, (state) => state.layout);
  const aggregates = useGridStore(store, (state) => state.aggregates);
  const activeCell = useGridStore(store, (state) => (state.selection ? `${state.selection.anchor.row}:${state.selection.anchor.col}` : null));

  const savedView = useSavedView(view, viewVersion);
  const viewLayout = useViewLayout(view, canEdit ? savedView.save : null);
  const [panelOpen, setPanelOpen] = useState(linkFilter !== null || linkFilterError !== null);
  const [fieldDialog, setFieldDialog] = useState<{ mode: "edit" | "delete"; field: Field } | { mode: "create" } | null>(null);
  const router = useRouter();
  // The page re-renders with the new schema; the grid is keyed by it and starts over with fresh rows.
  const schemaChanged = () => {
    setFieldDialog(null);
    router.refresh();
  };
  const [panelStatus, setPanelStatus] = useState({ dirty: false, active: view.sorts.length, fieldIds: "" });
  const applyQuery = useCallback(
    ({ filter, sorts, groupBy }: ViewQuery) => {
      const next = { filter, sorts, groupBy: (groupBy ?? []).map((group) => group.fieldId) };
      if (JSON.stringify(next) !== JSON.stringify({ filter: store.query.filter, sorts: store.query.sorts, groupBy: store.query.groupBy ?? [] })) {
        store.setQuery({ ...store.query, ...next });
      }
    },
    [store],
  );
  const columns = useMemo(() => gridColumns(fields, primaryFieldId, viewLayout.layout), [fields, primaryFieldId, viewLayout.layout]);
  const [pinned, ...scrollable] = columns;
  const pinnedWidth = GUTTER_WIDTH + pinned.width;
  // Intl formatters are expensive to create; build them once per column, not per cell render.
  const formatters = useMemo(
    () => new Map(columns.map((column) => [column.field.id, createCellFormatter(column.field, { locale, timeZone, labelOf: store.getLabel })])),
    [columns, locale, timeZone, store],
  );

  /** "Status: Shipped" for a group header; the group field may be hidden, so it gets its own formatter. */
  const groupTitle = (fieldId: string, key: CellValue) => {
    const field = fields.find((candidate) => candidate.id === fieldId);
    if (!field) return String(key ?? "");
    // SQLite returns checkboxes as 1/0, and an unchecked box is stored as empty.
    if (field.type === "checkbox") return `${field.name}: ${key === 1 || key === true ? "checked" : "not checked"}`;
    const text = (formatters.get(fieldId) ?? createCellFormatter(field, { locale, timeZone, labelOf: store.getLabel }))(key);
    return `${field.name}: ${text === "" ? "(empty)" : text}`;
  };

  const scrollRef = useRef<HTMLDivElement>(null);
  const rowHeight = ROW_HEIGHTS[view.rowHeight];
  const rowVirtualizer = useVirtualizer({
    // Rows on screen: with grouping, group headers and the rows of expanded groups (see groupLayout.ts).
    count: layout.count,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 8,
    paddingStart: HEADER_HEIGHT,
    paddingEnd: FOOTER_HEIGHT,
    // Keeps a row scrolled into view from hiding under the sticky header or footer.
    scrollPaddingStart: HEADER_HEIGHT,
    scrollPaddingEnd: FOOTER_HEIGHT,
    initialRect: INITIAL_RECT,
  });
  const columnVirtualizer = useVirtualizer({
    horizontal: true,
    count: scrollable.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => scrollable[index].width,
    overscan: 2,
    paddingStart: pinnedWidth,
    scrollPaddingStart: pinnedWidth,
    initialRect: INITIAL_RECT,
  });

  // Column sizes are estimates the virtualizer caches; after a resize or reorder it must re-measure.
  useEffect(() => {
    columnVirtualizer.measure();
  }, [columnVirtualizer, columns]);

  const virtualRows = rowVirtualizer.getVirtualItems();
  const virtualColumns = columnVirtualizer.getVirtualItems();
  const firstIndex = virtualRows[0]?.index ?? 0;
  const lastIndex = virtualRows.at(-1)?.index ?? 0;
  useEffect(() => {
    const range = layout.serverRange(firstIndex, lastIndex);
    if (range) store.ensureRange(range.first, range.last);
  }, [store, layout, firstIndex, lastIndex]);

  // Plain functions: they're only called from event handlers, so stable identities buy nothing.
  const getBounds = () => {
    const visibleHeight = (scrollRef.current?.clientHeight ?? INITIAL_RECT.height) - HEADER_HEIGHT - FOOTER_HEIGHT;
    return { rows: store.total, cols: columns.length, pageRows: Math.max(1, Math.floor(visibleHeight / rowHeight)) };
  };

  const scrollToCell = (cell: CellPosition) => {
    // A row inside a collapsed group is shown first (its groups expand), then scrolled to.
    const revealed = store.revealRow(cell.row);
    const display = store.layout.displayIndexOf(cell.row);
    // After expanding, wait a frame for the virtualizer to know the new row count.
    if (display !== null && revealed) requestAnimationFrame(() => rowVirtualizer.scrollToIndex(display, { align: "auto" }));
    else if (display !== null) rowVirtualizer.scrollToIndex(display, { align: "auto" });
    // Column 0 is pinned, so it's always visible, but reaching it (Cmd+Home, Home) should
    // still bring the table back to its start, as in Excel.
    if (cell.col === 0) columnVirtualizer.scrollToOffset(0);
    else columnVirtualizer.scrollToIndex(cell.col - 1, { align: "auto" });
  };

  const editing = useCellEditing({
    store,
    columns,
    canEdit,
    locale,
    timeZone,
    getBounds,
    scrollToCell,
    focusGrid: () => scrollRef.current?.focus({ preventScroll: true }),
  });
  const selection = useGridSelection(store, getBounds, scrollToCell, (source, toRow) => void editing.fill(source, toRow));
  const clipboard = useClipboard({ store, columns, canEdit, locale, timeZone, formatters });
  const realtimeStatus = useRealtime({
    tableId,
    viewId: view.id,
    store,
    fields,
    columns,
    locale,
    timeZone,
    onSchemaChange: (event) => {
      // Explain what closes: the grid remounts with the new fields, which closes any editor or dialog.
      const deleted = event.deletedFieldId ? fields.find((field) => field.id === event.deletedFieldId) : undefined;
      const editingField = store.editing ? columns[store.editing.col]?.field.id : undefined;
      const dialogField = fieldDialog && "field" in fieldDialog ? fieldDialog.field.id : undefined;
      // The panel's draft too: a condition being set up may not have reached the grid yet.
      const filtered = deleted !== undefined && panelStatus.fieldIds.split(",").includes(deleted.id);
      if (deleted && (editingField === deleted.id || dialogField === deleted.id)) {
        pushToast({ tone: "warning", message: `${event.origin.name} deleted the field “${deleted.name}” you were editing, so it was closed.` });
      } else if (deleted && filtered) {
        pushToast({ tone: "warning", message: `${event.origin.name} deleted the field “${deleted.name}” that your unsaved filter or sort used; it was reset to the saved view.` });
      } else {
        pushToast({ message: `${event.origin.name} changed the fields of this table.` });
      }
      router.refresh();
    },
    onViewSaved: (saved, version, by) => {
      savedView.applyRemote(saved, version);
      pushToast({ message: `${by} saved changes to this view.` });
    },
    currentUserId: currentUser.id,
    onOpenRecord: (rowId) => setRecord({ rowId, tab: "comments", fieldId: null }),
  });
  // The record side panel, and the right-click menu of a cell.
  const [record, setRecord] = useOpenRecord(initialRecordId ? { rowId: initialRecordId, tab: "comments", fieldId: null } : null);
  // A link to another record of this view (a mention in the inbox) re-renders the page with a new `?record=`.
  const [linkedRecordId, setLinkedRecordId] = useState(initialRecordId);
  if (linkedRecordId !== initialRecordId) {
    setLinkedRecordId(initialRecordId);
    if (initialRecordId) setRecord({ rowId: initialRecordId, tab: "comments", fieldId: null });
  }
  const recordRow = useGridStore(store, (state) => (record ? state.getRowById(record.rowId) : undefined));
  const [cellMenu, setCellMenu] = useState<{ x: number; y: number; cell: CellPosition } | null>(null);
  const openRecordAt = (cell: CellPosition, tab: RecordTab, fieldId: string | null = null) => {
    const row = store.getRowAt(cell.row);
    if (row) setRecord({ rowId: row.id, tab, fieldId });
  };
  const closeRecord = () => {
    setRecord(null);
    scrollRef.current?.focus({ preventScroll: true });
  };
  /** "Restore" in the cell history: an ordinary edit, so Cmd+Z undoes it (when the cell is on screen in this view). */
  const restoreValue = (rowId: string, fieldId: string, value: CellValue) => {
    const row = store.getRowById(rowId);
    const index = store.indexOfRow(rowId);
    const col = columns.findIndex((column) => column.field.id === fieldId);
    const name = fields.find((field) => field.id === fieldId)?.name ?? "a field";
    if (row && index !== null && col >= 0) {
      store.applyChanges(`restore of ${name}`, [{ rowId, fieldId, before: row.values[fieldId] ?? null, after: value, row: index, col }]);
    } else {
      store.writeCells([{ rowId, fieldId, value }]);
    }
    store.announce(`Restored an earlier value of ${name}`);
  };

  const announcement = useGridStore(store, (state) => state.announcement);
  const announcementId = useGridStore(store, (state) => state.announcementId);
  const idPrefix = useId();
  const [activeRow, activeCol] = activeCell ? activeCell.split(":").map(Number) : [];

  const width = columnVirtualizer.getTotalSize();
  const height = rowVirtualizer.getTotalSize();

  /** The first loaded rows, for the formula preview. */
  function previewRows(): Row[] {
    const rows: Row[] = [];
    for (let index = 0; index < 5; index++) {
      const row = store.getRowAt(index);
      if (row) rows.push(row);
    }
    return rows;
  }

  function addRow() {
    const index = store.addRow();
    const cell = { row: index, col: 0 };
    store.setSelection({ anchor: cell, focus: cell });
    // The row count just grew; scroll once the virtualizer knows about the new row.
    requestAnimationFrame(() => scrollToCell(cell));
    scrollRef.current?.focus({ preventScroll: true });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <GridToolbar
        store={store}
        canEdit={canEdit}
        primaryFieldId={primaryFieldId}
        fields={fields}
        hiddenFieldIds={viewLayout.layout.hiddenFieldIds}
        layoutError={viewLayout.error}
        panelOpen={panelOpen}
        panelStatus={panelStatus}
        realtimeStatus={realtimeStatus}
        onTogglePanel={() => setPanelOpen((open) => !open)}
        onAddField={canChangeSchema ? () => setFieldDialog({ mode: "create" }) : null}
        importHref={importHref}
        onAddRow={addRow}
        onExport={() => download(exportCsvUrl(tableId, view.id, store.query))}
        onToggleHidden={(fieldId, hidden) => viewLayout.update((layout) => setFieldHidden(layout, fieldId, hidden))}
      />
      <ViewPanel
        open={panelOpen}
        fields={fields}
        saved={savedView.view}
        save={canEdit ? savedView.save : null}
        onApply={applyQuery}
        linkFilter={linkFilter}
        linkFilterError={linkFilterError}
        onStatusChange={setPanelStatus}
        labelOf={store.getLabel}
      />
      <div
        ref={scrollRef}
        role="grid"
        tabIndex={0}
        aria-label={`${tableName} records`}
        aria-rowcount={layout.count + 2}
        aria-colcount={columns.length}
        aria-multiselectable
        aria-activedescendant={activeCell ? cellId(idPrefix, activeRow, activeCol) : undefined}
        className="relative min-h-0 flex-1 overflow-auto text-sm outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500"
        onKeyDown={(event) => {
          if (event.key === "Enter" && event.shiftKey && !store.editing && store.selection) {
            // Shift+Enter opens the record, with the active cell's history.
            event.preventDefault();
            return openRecordAt(store.selection.anchor, "history", columns[store.selection.anchor.col]?.field.id ?? null);
          }
          if (!selection.handleKey(event)) editing.handleKey(event);
        }}
        onClick={(event) => {
          const expand = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-expand-row]") : null;
          if (expand) openRecordAt({ row: Number(expand.dataset.expandRow), col: 0 }, "comments");
        }}
        onContextMenu={(event) => {
          const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-row][data-col]") : null;
          if (!target || store.editing) return;
          event.preventDefault();
          const cell = { row: Number(target.dataset.row), col: Number(target.dataset.col) };
          const range = store.selection ? rangeOf(store.selection) : null;
          const inside = range && cell.row >= range.top && cell.row <= range.bottom && cell.col >= range.left && cell.col <= range.right;
          if (!inside) store.setSelection({ anchor: cell, focus: cell });
          setCellMenu({ x: event.clientX, y: event.clientY, cell });
        }}
        onPointerDown={selection.onPointerDown}
        onPointerMove={selection.onPointerMove}
        onDoubleClick={editing.onDoubleClick}
        onCopy={clipboard.onCopy}
        onPaste={clipboard.onPaste}
      >
        {/* Results of edits, clears and failed saves, for screen readers. Keyed so a repeated message is read again. */}
        <div key={announcementId} role="status" aria-live="polite" className="sr-only">
          {announcement}
        </div>
        {/* Not memoized on purpose: only the one open editor reads this context, so a new value re-renders one component. */}
        <GridEditingContext.Provider value={editing.context}>
          <div className="relative" style={{ width, height }}>
            <GridHeader
              store={store}
              primaryFieldId={primaryFieldId}
              pinned={pinned}
              scrollable={scrollable}
              virtualColumns={virtualColumns}
              width={width}
              onResize={(fieldId, next) => viewLayout.update((layout) => setColumnWidth(layout, fieldId, next))}
              onMove={(fieldId, direction) => viewLayout.update((layout) => moveField(fields, primaryFieldId, layout, fieldId, direction))}
              onHide={(fieldId) => viewLayout.update((layout) => setFieldHidden(layout, fieldId, true))}
              canChangeSchema={canChangeSchema}
              onEditField={(field) => setFieldDialog({ mode: "edit", field })}
              onDeleteField={(field) => setFieldDialog({ mode: "delete", field })}
            />
            {/* Takes the rows' space in normal flow, so the sticky footer sits after them. */}
            <div style={{ height: Math.max(0, height - HEADER_HEIGHT - FOOTER_HEIGHT) }} />
            {virtualRows.map((virtualRow) => {
              const item = layout.itemAt(virtualRow.index);
              if (!item) return null;
              const shared = { store, top: virtualRow.start, height: virtualRow.size, width, pinned, scrollable, virtualColumns, formatters, displayIndex: virtualRow.index };
              if (item.kind === "group") {
                return <GroupHeaderRow key={virtualRow.key} {...shared} group={item.group} path={item.path} collapsed={item.collapsed} title={groupTitle(item.group.fieldId, item.group.key)} />;
              }
              return <GridRow key={virtualRow.key} {...shared} idPrefix={idPrefix} index={item.index} canFill={canEdit} />;
            })}
            <GridFooter
              locale={locale}
              total={total}
              aggregates={aggregates}
              pinned={pinned}
              scrollable={scrollable}
              virtualColumns={virtualColumns}
              formatters={formatters}
              width={width}
            />
          </div>
        </GridEditingContext.Provider>
      </div>
      <Toasts />
      {cellMenu && (
        <CellMenu
          x={cellMenu.x}
          y={cellMenu.y}
          onClose={() => setCellMenu(null)}
          items={[
            { label: "Expand record", onSelect: () => openRecordAt(cellMenu.cell, "comments") },
            { label: "Comment on record", onSelect: () => openRecordAt(cellMenu.cell, "comments") },
            { label: "Cell history", shortcut: "⇧↵", onSelect: () => openRecordAt(cellMenu.cell, "history", columns[cellMenu.cell.col]?.field.id ?? null) },
          ]}
        />
      )}
      {record && (
        <RecordPanel
          tableId={tableId}
          record={record}
          row={recordRow}
          fields={recordFields(fields, columns.map((column) => column.field))}
          primaryFieldId={primaryFieldId}
          currentUserId={currentUser.id}
          locale={locale}
          timeZone={timeZone}
          labelOf={store.getLabel}
          onRestore={canEdit ? (fieldId, value) => restoreValue(record.rowId, fieldId, value) : null}
          onChange={setRecord}
          onClose={closeRecord}
        />
      )}
      {fieldDialog?.mode === "delete" ? (
        <DeleteFieldDialog
          tableId={tableId}
          field={fieldDialog.field}
          tableNames={Object.fromEntries(tables.map((table) => [table.id, table.name]))}
          onClose={() => setFieldDialog(null)}
          onDeleted={schemaChanged}
        />
      ) : fieldDialog ? (
        <FieldDialog
          tableId={tableId}
          tables={tables}
          field={fieldDialog.mode === "edit" ? fieldDialog.field : null}
          previewRows={previewRows()}
          locale={locale}
          timeZone={timeZone}
          onClose={() => setFieldDialog(null)}
          onSaved={schemaChanged}
        />
      ) : null}
    </div>
  );
}
