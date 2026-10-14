import type { VirtualItem } from "@tanstack/react-virtual";
import { memo } from "react";
import type { RowGroup } from "@/lib/domain/api";
import type { CellFormatter } from "@/lib/format";
import type { GridStore } from "./GridStore";
import { GUTTER_WIDTH, type GridColumn } from "./layout";

type GroupHeaderRowProps = {
  store: GridStore;
  group: RowGroup;
  path: string;
  collapsed: boolean;
  displayIndex: number;
  top: number;
  height: number;
  width: number;
  pinned: GridColumn;
  scrollable: GridColumn[];
  virtualColumns: VirtualItem[];
  formatters: Map<string, CellFormatter>;
  /** "Status: Shipped": the group field's name and the formatted value of the group. */
  title: string;
};

/**
 * A group's header in a grouped view: a button to collapse or expand it, the group's
 * value and size, and the sums of its numeric columns in their columns (computed on the
 * server for the whole group, loaded or not).
 */
export const GroupHeaderRow = memo(function GroupHeaderRow({ store, group, path, collapsed, displayIndex, top, height, width, pinned, scrollable, virtualColumns, formatters, title }: GroupHeaderRowProps) {
  const background = group.level === 0 ? "bg-zinc-100 dark:bg-zinc-900" : "bg-zinc-50 dark:bg-zinc-900/60";
  return (
    <div role="row" aria-rowindex={displayIndex + 2} aria-level={group.level + 1} className={`absolute left-0 flex border-b border-zinc-300 text-sm dark:border-zinc-700 ${background}`} style={{ top, height, width }}>
      <div role="rowheader" aria-colindex={1} className={`sticky left-0 z-10 flex h-full items-center gap-1.5 ${background}`} style={{ width: GUTTER_WIDTH + pinned.width, paddingLeft: 8 + group.level * 16 }}>
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? "Expand" : "Collapse"} ${title}`}
          className="rounded px-1 text-zinc-500 hover:bg-zinc-200 dark:hover:bg-zinc-800"
          // Clicking here mustn't start a cell selection on the grid.
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => store.toggleGroup(path)}
        >
          {collapsed ? "▸" : "▾"}
        </button>
        <span className="truncate font-medium">{title}</span>
        <span className="shrink-0 text-xs text-zinc-500">{group.count.toLocaleString()}</span>
      </div>
      {virtualColumns.map((virtualColumn) => {
        const column = scrollable[virtualColumn.index];
        const aggregate = group.aggregates[column.field.id];
        return (
          <div
            key={column.field.id}
            role="gridcell"
            aria-colindex={virtualColumn.index + 2}
            className="absolute top-0 flex h-full items-center justify-end overflow-hidden px-2 text-xs text-zinc-500 tabular-nums"
            style={{ left: virtualColumn.start, width: virtualColumn.size }}
          >
            {aggregate ? <span className="truncate">Sum {formatters.get(column.field.id)!(aggregate.sum)}</span> : null}
          </div>
        );
      })}
    </div>
  );
});
