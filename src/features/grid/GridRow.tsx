import type { VirtualItem } from "@tanstack/react-virtual";
import { memo } from "react";
import type { CellFormatter } from "@/lib/format";
import { CellView } from "./CellView";
import type { GridStore } from "./GridStore";
import type { GridColumn } from "./layout";
import { useGridStore } from "./useGridStore";

type GridRowProps = {
  store: GridStore;
  index: number;
  top: number;
  height: number;
  width: number;
  pinned: GridColumn;
  scrollable: GridColumn[];
  virtualColumns: VirtualItem[];
  formatters: Map<string, CellFormatter>;
};

const cellClass = "flex h-full items-center overflow-hidden border-r border-zinc-200 px-2 dark:border-zinc-800";

function Placeholder() {
  return <span className="h-3 w-3/4 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800" />;
}

/**
 * One data row. It subscribes to its own row in the store, so a loaded window or an
 * edited cell re-renders only the rows involved.
 *
 * `memo` is here for a concrete reason: the grid re-renders on every scroll frame
 * (the virtualizer's state changes), and without `memo` all ~40 visible rows with
 * all their cells would re-render each frame although their props didn't change.
 * With `memo`, vertical scrolling only mounts the rows that come into view.
 */
export const GridRow = memo(function GridRow({ store, index, top, height, width, pinned, scrollable, virtualColumns, formatters }: GridRowProps) {
  const row = useGridStore(store, (state) => state.getRowAt(index));
  const status = useGridStore(store, (state) => state.getRowStatus(index));

  const cell = (column: GridColumn) =>
    row ? (
      <CellView
        field={column.field}
        value={row.values[column.field.id]}
        error={row.errors?.[column.field.id]}
        format={formatters.get(column.field.id)!}
        labelOf={store.getLabel}
      />
    ) : (
      <Placeholder />
    );

  return (
    <div
      role="row"
      aria-rowindex={index + 2}
      aria-busy={status === "loading" || undefined}
      className="absolute left-0 flex border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950"
      style={{ top, height, width }}
    >
      <div role="gridcell" aria-colindex={1} className={`${cellClass} sticky left-0 z-10 bg-white font-medium dark:bg-zinc-950`} style={{ width: pinned.width }}>
        {status === "error" ? (
          <button type="button" onClick={() => store.retry(index)} className="text-xs text-red-600 hover:underline">
            Couldn&apos;t load rows · Retry
          </button>
        ) : (
          cell(pinned)
        )}
      </div>
      {virtualColumns.map((virtualColumn) => {
        const column = scrollable[virtualColumn.index];
        return (
          <div
            key={column.field.id}
            role="gridcell"
            aria-colindex={virtualColumn.index + 2}
            className={`${cellClass} absolute top-0`}
            style={{ left: virtualColumn.start, width: virtualColumn.size }}
          >
            {status === "ready" && cell(column)}
          </div>
        );
      })}
    </div>
  );
});
