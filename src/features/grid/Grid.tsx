"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { RowWindowResponse } from "@/lib/domain/api";
import type { Field } from "@/lib/domain/field";
import type { View, ViewQuery } from "@/lib/domain/view";
import { createCellFormatter } from "@/lib/format";
import { ViewPanel } from "@/features/view-panel/ViewPanel";
import { fetchRowWindow, sendRowBatch } from "./api";
import { GridFooter } from "./GridFooter";
import { GridHeader } from "./GridHeader";
import { cellId, GridRow } from "./GridRow";
import { GridStore } from "./GridStore";
import { GridToolbar } from "./GridToolbar";
import { FOOTER_HEIGHT, gridColumns, GUTTER_WIDTH, HEADER_HEIGHT, moveField, ROW_HEIGHTS, setColumnWidth, setFieldHidden } from "./layout";
import type { CellPosition } from "./selection";
import { useCellEditing } from "./useCellEditing";
import { useClipboard } from "./useClipboard";
import { GridEditingContext } from "./GridEditingContext";
import { useGridSelection } from "./useGridSelection";
import { useGridStore } from "./useGridStore";
import { useSavedView } from "./useSavedView";
import { useViewerLocale } from "./useViewerLocale";
import { useViewLayout } from "./useViewLayout";

type GridProps = {
  tableId: string;
  /** Whether the current user may edit records. Only shapes the UI: the server checks again. */
  canEdit: boolean;
  tableName: string;
  fields: Field[];
  primaryFieldId: string;
  view: View;
  /** The view's version, sent as If-Match when the column layout is saved. */
  viewVersion: number;
  initialWindow: RowWindowResponse;
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
export function Grid({ tableId, canEdit, tableName, fields, primaryFieldId, view, viewVersion, initialWindow }: GridProps) {
  const [store] = useState(
    () =>
      new GridStore({
        query: { filter: view.filter, sorts: view.sorts, timeZone: "UTC" },
        fields,
        fetchWindow: (query, offset, limit, signal) => fetchRowWindow(tableId, query, offset, limit, signal),
        sendBatch: (ops) => sendRowBatch(tableId, ops),
        initialWindow,
      }),
  );
  useEffect(() => () => store.dispose(), [store]);

  const { locale, timeZone } = useViewerLocale();
  useEffect(() => store.setTimeZone(timeZone), [store, timeZone]);

  const total = useGridStore(store, (state) => state.total);
  const aggregates = useGridStore(store, (state) => state.aggregates);
  const activeCell = useGridStore(store, (state) => (state.selection ? `${state.selection.anchor.row}:${state.selection.anchor.col}` : null));

  const savedView = useSavedView(view, viewVersion);
  const viewLayout = useViewLayout(view, canEdit ? savedView.save : null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelStatus, setPanelStatus] = useState({ dirty: false, active: view.sorts.length });
  const applyQuery = useCallback(
    ({ filter, sorts }: ViewQuery) => {
      if (JSON.stringify({ filter, sorts }) !== JSON.stringify({ filter: store.query.filter, sorts: store.query.sorts })) {
        store.setQuery({ ...store.query, filter, sorts });
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

  const scrollRef = useRef<HTMLDivElement>(null);
  const rowHeight = ROW_HEIGHTS[view.rowHeight];
  const rowVirtualizer = useVirtualizer({
    count: total,
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
    store.ensureRange(firstIndex, lastIndex);
  }, [store, firstIndex, lastIndex]);

  // Plain functions: they're only called from event handlers, so stable identities buy nothing.
  const getBounds = () => {
    const visibleHeight = (scrollRef.current?.clientHeight ?? INITIAL_RECT.height) - HEADER_HEIGHT - FOOTER_HEIGHT;
    return { rows: store.total, cols: columns.length, pageRows: Math.max(1, Math.floor(visibleHeight / rowHeight)) };
  };

  const scrollToCell = (cell: CellPosition) => {
    rowVirtualizer.scrollToIndex(cell.row, { align: "auto" });
    // Column 0 is pinned, so it's always visible, but reaching it (Cmd+Home, Home) should
    // still bring the table back to its start, as in Excel.
    if (cell.col === 0) columnVirtualizer.scrollToOffset(0);
    else columnVirtualizer.scrollToIndex(cell.col - 1, { align: "auto" });
  };

  const selection = useGridSelection(store, getBounds, scrollToCell);
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
  const clipboard = useClipboard({ store, columns, canEdit, locale, timeZone, formatters });
  const announcement = useGridStore(store, (state) => state.announcement);
  const announcementId = useGridStore(store, (state) => state.announcementId);
  const idPrefix = useId();
  const [activeRow, activeCol] = activeCell ? activeCell.split(":").map(Number) : [];

  const width = columnVirtualizer.getTotalSize();
  const height = rowVirtualizer.getTotalSize();

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
        onTogglePanel={() => setPanelOpen((open) => !open)}
        onAddRow={addRow}
        onToggleHidden={(fieldId, hidden) => viewLayout.update((layout) => setFieldHidden(layout, fieldId, hidden))}
      />
      <ViewPanel
        open={panelOpen}
        fields={fields}
        saved={savedView.view}
        save={canEdit ? savedView.save : null}
        onApply={applyQuery}
        onStatusChange={setPanelStatus}
        labelOf={store.getLabel}
      />
      <div
        ref={scrollRef}
        role="grid"
        tabIndex={0}
        aria-label={`${tableName} records`}
        aria-rowcount={total + 2}
        aria-colcount={columns.length}
        aria-multiselectable
        aria-activedescendant={activeCell ? cellId(idPrefix, activeRow, activeCol) : undefined}
        className="relative min-h-0 flex-1 overflow-auto text-sm outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500"
        onKeyDown={(event) => {
          if (!selection.handleKey(event)) editing.handleKey(event);
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
            />
            {/* Takes the rows' space in normal flow, so the sticky footer sits after them. */}
            <div style={{ height: Math.max(0, height - HEADER_HEIGHT - FOOTER_HEIGHT) }} />
            {virtualRows.map((virtualRow) => (
              <GridRow
                key={virtualRow.key}
                store={store}
                idPrefix={idPrefix}
                index={virtualRow.index}
                top={virtualRow.start}
                height={virtualRow.size}
                width={width}
                pinned={pinned}
                scrollable={scrollable}
                virtualColumns={virtualColumns}
                formatters={formatters}
              />
            ))}
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
    </div>
  );
}
