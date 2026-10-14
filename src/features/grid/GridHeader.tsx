import type { VirtualItem } from "@tanstack/react-virtual";
import type { Field } from "@/lib/domain/field";
import { ColumnMenu } from "./ColumnMenu";
import type { GridStore } from "./GridStore";
import { GUTTER_WIDTH, HEADER_HEIGHT, type GridColumn } from "./layout";
import { useGridStore } from "./useGridStore";

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

const headerCellClass =
  "flex h-full cursor-pointer items-center gap-1.5 overflow-hidden border-r border-zinc-200 px-2 font-medium text-zinc-700 dark:border-zinc-800 dark:text-zinc-200";

type GridHeaderProps = {
  store: GridStore;
  primaryFieldId: string;
  pinned: GridColumn;
  scrollable: GridColumn[];
  virtualColumns: VirtualItem[];
  width: number;
  onResize: (fieldId: string, width: number) => void;
  onMove: (fieldId: string, direction: -1 | 1) => void;
  onHide: (fieldId: string) => void;
};

const RESIZE_STEP = 16;

/**
 * Drag handle on a header's right edge; also works from the keyboard (focus it,
 * then ←/→). The width is applied live and saved by the view layout hook.
 */
function ResizeHandle({ column, onResize }: { column: GridColumn; onResize: (width: number) => void }) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${column.field.name}`}
      aria-valuenow={column.width}
      tabIndex={0}
      className="absolute top-0 right-0 z-10 h-full w-1.5 cursor-col-resize hover:bg-blue-400 focus:bg-blue-500 focus:outline-none"
      onPointerDown={(event) => {
        // Keeps the grid from treating this as "select the column".
        event.stopPropagation();
        event.preventDefault();
        const handle = event.currentTarget;
        const startX = event.clientX;
        const startWidth = column.width;
        handle.setPointerCapture(event.pointerId);
        const move = (moveEvent: PointerEvent) => onResize(startWidth + moveEvent.clientX - startX);
        const up = () => {
          handle.removeEventListener("pointermove", move);
          handle.removeEventListener("pointerup", up);
        };
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", up);
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "ArrowLeft") onResize(column.width - RESIZE_STEP);
        if (event.key === "ArrowRight") onResize(column.width + RESIZE_STEP);
      }}
    />
  );
}

/** Column headers. Clicking one selects the whole column (handled by the grid via `data-header-col`). */
export function GridHeader({ store, primaryFieldId, pinned, scrollable, virtualColumns, width, onResize, onMove, onHide }: GridHeaderProps) {
  const selectedKey = useGridStore(store, (state) => state.getSelectedColumnsKey());
  const [left, right] = selectedKey ? selectedKey.split(":").map(Number) : [-1, -1];
  const background = (col: number) => (col >= left && col <= right ? "bg-blue-50 dark:bg-blue-950" : "bg-zinc-50 dark:bg-zinc-900");

  const header = (column: GridColumn, col: number, className: string, style: React.CSSProperties) => (
    <div
      key={column.field.id}
      role="columnheader"
      aria-colindex={col + 1}
      data-header-col={col}
      className={`${headerCellClass} ${background(col)} ${className} group`}
      style={style}
    >
      <span aria-hidden className="w-4 shrink-0 text-center text-xs text-zinc-400">
        {TYPE_ICONS[column.field.type]}
      </span>
      <span className="truncate">{column.field.name}</span>
      <ColumnMenu
        field={column.field}
        isPrimary={column.field.id === primaryFieldId}
        onMove={(direction) => onMove(column.field.id, direction)}
        onHide={() => onHide(column.field.id)}
      />
      <ResizeHandle column={column} onResize={(next) => onResize(column.field.id, next)} />
    </div>
  );

  return (
    <div role="row" aria-rowindex={1} className="sticky top-0 z-20 flex border-b border-zinc-300 dark:border-zinc-700" style={{ height: HEADER_HEIGHT, width }}>
      <div className="sticky left-0 z-30 flex h-full">
        <div aria-hidden className="h-full shrink-0 border-r border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900" style={{ width: GUTTER_WIDTH }} />
        {header(pinned, 0, "relative", { width: pinned.width })}
      </div>
      {virtualColumns.map((virtualColumn) =>
        header(scrollable[virtualColumn.index], virtualColumn.index + 1, "absolute top-0", { left: virtualColumn.start, width: virtualColumn.size }),
      )}
    </div>
  );
}
