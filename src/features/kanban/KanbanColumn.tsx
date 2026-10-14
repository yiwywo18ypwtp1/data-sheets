import { useState, type DragEvent, type KeyboardEvent } from "react";
import type { KanbanColumnData } from "@/lib/domain/api";
import type { Field } from "@/lib/domain/field";
import type { Row } from "@/lib/domain/row";
import type { CellFormatter } from "@/lib/format";

/** The drag payload: a record id, under our own type so foreign drops (files, text) are ignored. */
export const CARD_MIME = "application/x-data-sheets-record";

type KanbanColumnProps = {
  column: KanbanColumnData;
  title: string;
  color: string | null;
  primaryFieldId: string;
  /** Fields shown on cards under the title (the view's visible fields). */
  cardFields: Field[];
  formatters: Map<string, CellFormatter>;
  canEdit: boolean;
  /** A card is being dragged over this column. */
  dropTarget: boolean;
  dragging: boolean;
  onDragOverColumn: (key: string | null) => void;
  onDropCard: (rowId: string, key: string | null) => void;
  onDragCard: (rowId: string | null) => void;
  onOpen: (rowId: string) => void;
  onCardKey: (event: KeyboardEvent<HTMLButtonElement>, rowId: string) => void;
  onShowMore: (key: string | null) => void;
  onAdd: ((key: string | null, text: string) => void) | null;
};

/** One column: its header with the count, the loaded cards, "Show more" and an inline "+ Add". */
export function KanbanColumn(props: KanbanColumnProps) {
  const { column, title, color, primaryFieldId, cardFields, formatters, canEdit, dropTarget, dragging, onDragOverColumn, onDropCard, onDragCard, onOpen, onCardKey, onShowMore, onAdd } = props;
  const [adding, setAdding] = useState(false);
  const accepts = (event: DragEvent) => dragging && event.dataTransfer.types.includes(CARD_MIME);

  return (
    <section
      aria-label={`${title}, ${column.count} ${column.count === 1 ? "record" : "records"}`}
      data-column={column.key ?? ""}
      className={`flex max-h-full w-72 shrink-0 flex-col rounded-lg border bg-zinc-50 dark:bg-zinc-900 ${dropTarget ? "border-blue-500 ring-2 ring-blue-500/30" : "border-zinc-200 dark:border-zinc-800"}`}
      onDragOver={(event) => {
        if (!accepts(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        onDragOverColumn(column.key);
      }}
      onDrop={(event) => {
        const rowId = event.dataTransfer.getData(CARD_MIME);
        if (!rowId) return;
        event.preventDefault();
        onDropCard(rowId, column.key);
      }}
    >
      <header className="flex items-center gap-2 px-3 py-2">
        <span className="truncate rounded px-2 py-0.5 text-sm font-medium" style={color ? { backgroundColor: `${color}22`, color } : undefined}>
          {title}
        </span>
        <span className="ml-auto text-xs text-zinc-500 tabular-nums">{column.count.toLocaleString()}</span>
      </header>
      <ol className="flex min-h-12 flex-col gap-2 overflow-y-auto px-2 pb-2">
        {column.rows.map((row) => (
          <li key={row.id}>
            <Card row={row} primaryFieldId={primaryFieldId} cardFields={cardFields} formatters={formatters} draggable={canEdit} onDrag={onDragCard} onOpen={onOpen} onKey={onCardKey} />
          </li>
        ))}
        {column.rows.length < column.count && (
          <li>
            <button type="button" className="w-full rounded py-1 text-xs text-zinc-500 hover:bg-zinc-200/60 dark:hover:bg-zinc-800" onClick={() => onShowMore(column.key)}>
              Show more ({(column.count - column.rows.length).toLocaleString()} left)
            </button>
          </li>
        )}
      </ol>
      {onAdd &&
        (adding ? (
          <form
            className="px-2 pb-2"
            onSubmit={(event) => {
              event.preventDefault();
              const input = event.currentTarget.elements.namedItem("name") as HTMLInputElement;
              onAdd(column.key, input.value);
              input.value = "";
            }}
          >
            <input
              name="name"
              autoFocus
              aria-label={`New record in ${title}`}
              placeholder="Name, then Enter"
              className="w-full rounded border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-950"
              onKeyDown={(event) => {
                if (event.key === "Escape") setAdding(false);
              }}
              onBlur={() => setAdding(false)}
            />
          </form>
        ) : (
          <button type="button" className="mx-2 mb-2 rounded px-2 py-1 text-left text-sm text-zinc-500 hover:bg-zinc-200/60 dark:hover:bg-zinc-800" onClick={() => setAdding(true)}>
            + Add record
          </button>
        ))}
    </section>
  );
}

type CardProps = {
  row: Row & { saving?: boolean };
  primaryFieldId: string;
  cardFields: Field[];
  formatters: Map<string, CellFormatter>;
  draggable: boolean;
  onDrag: (rowId: string | null) => void;
  onOpen: (rowId: string) => void;
  onKey: (event: KeyboardEvent<HTMLButtonElement>, rowId: string) => void;
};

/** A card: the primary value and the non-empty visible fields. A button: Enter opens the record. */
function Card({ row, primaryFieldId, cardFields, formatters, draggable, onDrag, onOpen, onKey }: CardProps) {
  const title = formatters.get(primaryFieldId)?.(row.values[primaryFieldId]) || "Unnamed record";
  const lines = cardFields.flatMap((field) => {
    const text = formatters.get(field.id)?.(row.values[field.id]) ?? "";
    return text ? [{ field, text }] : [];
  });
  return (
    <button
      type="button"
      data-card={row.id}
      draggable={draggable}
      aria-roledescription={draggable ? "draggable card" : "card"}
      aria-keyshortcuts={draggable ? "Alt+ArrowLeft Alt+ArrowRight" : undefined}
      className={`block w-full cursor-pointer rounded-md border border-zinc-200 bg-white p-2.5 text-left text-sm shadow-xs hover:border-zinc-300 focus-visible:outline-2 focus-visible:outline-blue-500 dark:border-zinc-800 dark:bg-zinc-950 ${row.saving ? "opacity-70" : ""}`}
      onClick={() => onOpen(row.id)}
      onKeyDown={(event) => onKey(event, row.id)}
      onDragStart={(event) => {
        event.dataTransfer.setData(CARD_MIME, row.id);
        event.dataTransfer.effectAllowed = "move";
        onDrag(row.id);
      }}
      onDragEnd={() => onDrag(null)}
    >
      <span className="block truncate font-medium">{title}</span>
      {lines.slice(0, 4).map(({ field, text }) => (
        <span key={field.id} className="mt-1 flex gap-1.5 text-xs">
          <span className="shrink-0 text-zinc-500">{field.name}</span>
          <span className="truncate">{text}</span>
        </span>
      ))}
    </button>
  );
}
