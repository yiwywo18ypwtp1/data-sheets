import type { VirtualItem } from "@tanstack/react-virtual";
import { memo, type CSSProperties } from "react";
import type { CellFormatter } from "@/lib/format";
import { CellView } from "./CellView";
import { CellEditor } from "./editors/CellEditor";
import type { GridStore } from "./GridStore";
import { GUTTER_WIDTH, type GridColumn } from "./layout";
import { parseRowSelectionKey, type RowSelection } from "./selection";
import { useGridStore } from "./useGridStore";

type GridRowProps = {
  store: GridStore;
  /** Prefix for cell ids, referenced by the grid's aria-activedescendant. */
  idPrefix: string;
  index: number;
  top: number;
  height: number;
  width: number;
  pinned: GridColumn;
  scrollable: GridColumn[];
  virtualColumns: VirtualItem[];
  formatters: Map<string, CellFormatter>;
};

export const cellId = (idPrefix: string, row: number, col: number) => `${idPrefix}-r${row}-c${col}`;

const cellClass = "flex h-full items-center overflow-hidden border-r border-zinc-200 px-2 dark:border-zinc-800";
const SELECTION_COLOR = "#2563eb";
const ERROR_COLOR = "#dc2626";

/**
 * The Excel-like frame is drawn per cell with inset box-shadows on the range's outer
 * edges. A single overlay rectangle would be simpler to draw, but it can't follow the
 * pinned column and the sticky header; per-cell edges stick together with their cells.
 */
function selectionStyle(selection: RowSelection | null, col: number): { selected: boolean; style: CSSProperties } {
  if (!selection || col < selection.left || col > selection.right) return { selected: false, style: {} };
  if (col === selection.activeCol) return { selected: true, style: { boxShadow: `inset 0 0 0 2px ${SELECTION_COLOR}` } };
  const edges = [
    selection.top && `inset 0 2px 0 ${SELECTION_COLOR}`,
    selection.bottom && `inset 0 -2px 0 ${SELECTION_COLOR}`,
    col === selection.left && `inset 2px 0 0 ${SELECTION_COLOR}`,
    col === selection.right && `inset -2px 0 0 ${SELECTION_COLOR}`,
  ].filter(Boolean);
  return {
    selected: true,
    style: { backgroundColor: "rgb(37 99 235 / 0.08)", boxShadow: edges.length > 0 ? edges.join(", ") : undefined },
  };
}

function Placeholder() {
  return <span className="h-3 w-3/4 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800" />;
}

/**
 * One data row. It subscribes to its own row and to its own slice of the selection
 * (a short string), so loading a window, editing a cell or moving the selection
 * re-renders only the rows involved.
 *
 * `memo` is here for a concrete reason: the grid re-renders on every scroll frame
 * (the virtualizer's state changes), and without `memo` all ~40 visible rows with
 * all their cells would re-render each frame although their props didn't change.
 * With `memo`, vertical scrolling only mounts the rows that come into view.
 */
export const GridRow = memo(function GridRow({ store, idPrefix, index, top, height, width, pinned, scrollable, virtualColumns, formatters }: GridRowProps) {
  const row = useGridStore(store, (state) => state.getRowAt(index));
  const status = useGridStore(store, (state) => state.getRowStatus(index));
  const selection = parseRowSelectionKey(useGridStore(store, (state) => state.getRowSelectionKey(index)));
  const editingCol = useGridStore(store, (state) => state.getEditingCol(index));
  const presenceKey = useGridStore(store, (state) => state.getPresenceKey(row?.id));
  const presence = presenceKey ? presenceKey.split(";").map((entry) => entry.split("|")) : [];

  const cell = (column: GridColumn, col: number, className: string, style: CSSProperties) => {
    const { selected, style: selectedStyle } = selectionStyle(selection, col);
    const saveError = row?.saveErrors?.[column.field.id];
    const editing = row !== undefined && col === editingCol;
    // Another user's selected cell: a frame in their colour (under this tab's own frame).
    const other = presence.find(([fieldId]) => fieldId === column.field.id);
    const otherStyle: CSSProperties = other && !selected ? { boxShadow: `inset 0 0 0 2px ${other[1]}` } : {};
    return (
      <div
        key={column.field.id}
        id={cellId(idPrefix, index, col)}
        role="gridcell"
        aria-colindex={col + 1}
        aria-selected={selected}
        aria-invalid={saveError ? true : undefined}
        title={saveError ?? (other ? `${other[2]} is here` : undefined)}
        data-row={index}
        data-col={col}
        className={`${cellClass} ${className}`}
        // A cell whose save failed keeps a red frame (over the selection's) until it's edited again.
        style={{ ...style, ...otherStyle, ...selectedStyle, ...(saveError ? { boxShadow: `inset 0 0 0 2px ${ERROR_COLOR}` } : {}) }}
      >
        {editing ? (
          <CellEditor field={column.field} value={row.values[column.field.id]} initialText={store.editing?.initialText ?? null} />
        ) : row ? (
          <CellView
            field={column.field}
            value={row.values[column.field.id]}
            error={row.errors?.[column.field.id]}
            format={formatters.get(column.field.id)!}
            labelOf={store.getLabel}
          />
        ) : col === 0 && status === "loading" ? (
          <Placeholder />
        ) : null}
      </div>
    );
  };

  return (
    <div
      role="row"
      aria-rowindex={index + 2}
      aria-busy={status === "loading" || undefined}
      // A row being deleted stays visible, dimmed and struck through, until the server confirms.
      className={`absolute left-0 flex border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950 ${row?.deleting ? "line-through opacity-40" : ""}`}
      style={{ top, height, width }}
    >
      <div className="sticky left-0 z-10 flex h-full bg-white dark:bg-zinc-950">
        {/* Row numbers: a mouse target for selecting whole rows (Shift+Space does it from the keyboard). */}
        <div
          aria-hidden
          data-row-gutter={index}
          className="flex h-full shrink-0 cursor-pointer items-center justify-end border-r border-zinc-200 pr-2 text-xs text-zinc-400 tabular-nums hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900"
          style={{ width: GUTTER_WIDTH }}
        >
          {index + 1}
        </div>
        {status === "error" ? (
          <div role="gridcell" aria-colindex={1} className={cellClass} style={{ width: pinned.width }}>
            <button type="button" onClick={() => store.retry(index)} className="text-xs text-red-600 hover:underline">
              Couldn&apos;t load rows · Retry
            </button>
          </div>
        ) : (
          cell(pinned, 0, "font-medium", { width: pinned.width })
        )}
      </div>
      {virtualColumns.map((virtualColumn) =>
        cell(scrollable[virtualColumn.index], virtualColumn.index + 1, "absolute top-0", { left: virtualColumn.start, width: virtualColumn.size }),
      )}
    </div>
  );
});
