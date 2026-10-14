"use client";

import { useVirtualizer, type VirtualItem } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Aggregates, RowWindowResponse } from "@/lib/domain/api";
import type { Field } from "@/lib/domain/field";
import type { View } from "@/lib/domain/view";
import { createCellFormatter, type CellFormatter } from "@/lib/format";
import { fetchRowWindow } from "./api";
import { GridRow } from "./GridRow";
import { GridStore } from "./GridStore";
import { FOOTER_HEIGHT, gridColumns, HEADER_HEIGHT, ROW_HEIGHTS, type GridColumn } from "./layout";
import { useGridStore } from "./useGridStore";
import { useViewerLocale } from "./useViewerLocale";

type GridProps = {
  tableId: string;
  tableName: string;
  fields: Field[];
  primaryFieldId: string;
  view: View;
  initialWindow: RowWindowResponse;
};

/** Size assumed before the browser measures the container, so the server renders the first rows too. */
const INITIAL_RECT = { width: 1280, height: 800 };

/**
 * The virtualized grid. One scroll container, two virtualizers (rows and columns),
 * so only the cells on screen exist in the DOM: about 40 rows × 10 columns out of
 * 50 000 × 30. The header and footer stick vertically; the primary column sticks
 * horizontally.
 */
export function Grid({ tableId, tableName, fields, primaryFieldId, view, initialWindow }: GridProps) {
  const [store] = useState(
    () =>
      new GridStore({
        query: { filter: view.filter, sorts: view.sorts, timeZone: "UTC" },
        fetchWindow: (query, offset, limit, signal) => fetchRowWindow(tableId, query, offset, limit, signal),
        initialWindow,
      }),
  );
  useEffect(() => () => store.dispose(), [store]);

  const { locale, timeZone } = useViewerLocale();
  useEffect(() => store.setTimeZone(timeZone), [store, timeZone]);

  const total = useGridStore(store, (state) => state.total);
  const aggregates = useGridStore(store, (state) => state.aggregates);

  const columns = useMemo(() => gridColumns(fields, primaryFieldId, view), [fields, primaryFieldId, view]);
  const [pinned, ...scrollable] = columns;
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
    initialRect: INITIAL_RECT,
  });
  const columnVirtualizer = useVirtualizer({
    horizontal: true,
    count: scrollable.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => scrollable[index].width,
    overscan: 2,
    paddingStart: pinned.width,
    initialRect: INITIAL_RECT,
  });

  const virtualRows = rowVirtualizer.getVirtualItems();
  const virtualColumns = columnVirtualizer.getVirtualItems();
  const firstIndex = virtualRows[0]?.index ?? 0;
  const lastIndex = virtualRows.at(-1)?.index ?? 0;
  useEffect(() => {
    store.ensureRange(firstIndex, lastIndex);
  }, [store, firstIndex, lastIndex]);

  const width = columnVirtualizer.getTotalSize();
  const height = rowVirtualizer.getTotalSize();

  return (
    <div
      ref={scrollRef}
      role="grid"
      aria-label={`${tableName} records`}
      aria-rowcount={total + 2}
      aria-colcount={columns.length}
      className="relative min-h-0 flex-1 overflow-auto text-sm"
    >
      <div className="relative" style={{ width, height }}>
        <GridHeader pinned={pinned} scrollable={scrollable} virtualColumns={virtualColumns} width={width} />
        {/* Takes the rows' space in normal flow, so the sticky footer sits after them. */}
        <div style={{ height: Math.max(0, height - HEADER_HEIGHT - FOOTER_HEIGHT) }} />
        {virtualRows.map((virtualRow) => (
          <GridRow
            key={virtualRow.key}
            store={store}
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
    </div>
  );
}

const TYPE_ICONS: Record<Field["type"], string> = {
  text: "Aa",
  number: "#",
  currency: "$",
  date: "📅",
  checkbox: "☑",
  singleSelect: "◉",
  multiSelect: "☰",
  email: "@",
  url: "🔗",
  link: "↗",
  lookup: "⤷",
  formula: "ƒ",
};

const headerCellClass = "flex h-full items-center gap-1.5 overflow-hidden border-r border-zinc-200 bg-zinc-50 px-2 font-medium text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200";

type BandProps = { pinned: GridColumn; scrollable: GridColumn[]; virtualColumns: VirtualItem[]; width: number };

function GridHeader({ pinned, scrollable, virtualColumns, width }: BandProps) {
  const label = (column: GridColumn) => (
    <>
      <span aria-hidden className="w-4 shrink-0 text-center text-xs text-zinc-400">
        {TYPE_ICONS[column.field.type]}
      </span>
      <span className="truncate">{column.field.name}</span>
    </>
  );
  return (
    <div role="row" aria-rowindex={1} className="sticky top-0 z-20 flex border-b border-zinc-300 dark:border-zinc-700" style={{ height: HEADER_HEIGHT, width }}>
      <div role="columnheader" aria-colindex={1} className={`${headerCellClass} sticky left-0 z-30`} style={{ width: pinned.width }}>
        {label(pinned)}
      </div>
      {virtualColumns.map((virtualColumn) => {
        const column = scrollable[virtualColumn.index];
        return (
          <div
            key={column.field.id}
            role="columnheader"
            aria-colindex={virtualColumn.index + 2}
            className={`${headerCellClass} absolute top-0`}
            style={{ left: virtualColumn.start, width: virtualColumn.size }}
          >
            {label(column)}
          </div>
        );
      })}
    </div>
  );
}

type FooterProps = BandProps & { locale: string; total: number; aggregates: Aggregates; formatters: Map<string, CellFormatter> };

/** Totals for the whole filtered set (computed on the server), not just the loaded rows. */
function GridFooter({ locale, total, aggregates, pinned, scrollable, virtualColumns, formatters, width }: FooterProps) {
  return (
    <div
      role="row"
      aria-rowindex={total + 2}
      className="sticky bottom-0 z-20 flex border-t border-zinc-300 bg-zinc-50 text-xs text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900"
      style={{ height: FOOTER_HEIGHT, width }}
    >
      <div role="gridcell" aria-colindex={1} className="sticky left-0 z-30 flex items-center bg-zinc-50 px-2 dark:bg-zinc-900" style={{ width: pinned.width }}>
        {/* An explicit locale: the server's default and the browser's may differ (hydration mismatch). */}
        {total.toLocaleString(locale)} {total === 1 ? "record" : "records"}
      </div>
      {virtualColumns.map((virtualColumn) => {
        const column = scrollable[virtualColumn.index];
        const aggregate = aggregates[column.field.id];
        const format = formatters.get(column.field.id)!;
        return (
          <div
            key={column.field.id}
            role="gridcell"
            aria-colindex={virtualColumn.index + 2}
            className="absolute top-0 flex h-full items-center justify-end overflow-hidden px-2 tabular-nums"
            style={{ left: virtualColumn.start, width: virtualColumn.size }}
            title={aggregate?.avg !== null && aggregate ? `Average: ${format(aggregate.avg)}` : undefined}
          >
            {aggregate ? <span className="truncate">Sum {format(aggregate.sum)}</span> : null}
          </div>
        );
      })}
    </div>
  );
}
