import type { VirtualItem } from "@tanstack/react-virtual";
import type { Aggregates } from "@/lib/domain/api";
import type { CellFormatter } from "@/lib/format";
import { FOOTER_HEIGHT, GUTTER_WIDTH, type GridColumn } from "./layout";

type GridFooterProps = {
  locale: string;
  total: number;
  aggregates: Aggregates;
  pinned: GridColumn;
  scrollable: GridColumn[];
  virtualColumns: VirtualItem[];
  formatters: Map<string, CellFormatter>;
  width: number;
};

/** Totals for the whole filtered set (computed on the server), not just the loaded rows. */
export function GridFooter({ locale, total, aggregates, pinned, scrollable, virtualColumns, formatters, width }: GridFooterProps) {
  return (
    <div
      role="row"
      aria-rowindex={total + 2}
      className="sticky bottom-0 z-20 flex border-t border-zinc-300 bg-zinc-50 text-xs text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900"
      style={{ height: FOOTER_HEIGHT, width }}
    >
      <div role="gridcell" aria-colindex={1} className="sticky left-0 z-30 flex items-center bg-zinc-50 px-2 dark:bg-zinc-900" style={{ width: GUTTER_WIDTH + pinned.width }}>
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
            title={aggregate && aggregate.avg !== null ? `Average: ${format(aggregate.avg)}` : undefined}
          >
            {aggregate ? <span className="truncate">Sum {format(aggregate.sum)}</span> : null}
          </div>
        );
      })}
    </div>
  );
}
