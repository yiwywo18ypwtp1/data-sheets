import type { KeyboardEvent, MouseEvent } from "react";
import type { CellValue } from "@/lib/domain/cell";
import { isComputedField } from "@/lib/domain/field";
import type { CommitMove, GridEditing } from "./GridEditingContext";
import type { GridStore } from "./GridStore";
import type { HistoryChange } from "./history";
import type { GridColumn } from "./layout";
import { collapsed, navigate, rangeOf, type Bounds, type CellPosition, type KeyInput } from "./selection";

type Options = {
  store: GridStore;
  columns: GridColumn[];
  canEdit: boolean;
  locale: string;
  timeZone: string;
  getBounds: () => Bounds;
  scrollToCell: (cell: CellPosition) => void;
  /** Returns keyboard focus to the grid after an editor closes. */
  focusGrid: () => void;
};

const MOVE_KEYS: Record<Exclude<CommitMove, "none">, KeyInput> = {
  down: { key: "ArrowDown", shiftKey: false, metaKey: false, ctrlKey: false, altKey: false },
  up: { key: "ArrowUp", shiftKey: false, metaKey: false, ctrlKey: false, altKey: false },
  right: { key: "Tab", shiftKey: false, metaKey: false, ctrlKey: false, altKey: false },
  left: { key: "Tab", shiftKey: true, metaKey: false, ctrlKey: false, altKey: false },
};

const sameValue = (a: CellValue | undefined, b: CellValue | undefined) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Starting, committing and cancelling cell edits, and clearing a range with Delete.
 * Permission checks here only shape the UI; the server rejects writes from viewers anyway.
 */
export function useCellEditing({ store, columns, canEdit, locale, timeZone, getBounds, scrollToCell, focusGrid }: Options) {
  function startEditing(cell: CellPosition, initialText: string | null) {
    const column = columns[cell.col];
    const row = store.getRowAt(cell.row);
    if (!column || !row) return;
    if (!canEdit) return store.announce("You have view-only access to this table");
    if (isComputedField(column.field)) return store.announce(`${column.field.name} is computed and can't be edited`);
    if (column.field.type === "checkbox") {
      // Checkboxes have no editor: Enter, Space or a typed character toggles them.
      const before = row.values[column.field.id] ?? null;
      return store.applyChanges(`edit of ${column.field.name}`, [
        { rowId: row.id, fieldId: column.field.id, before, after: before !== true, row: cell.row, col: cell.col },
      ]);
    }
    store.startEditing({ row: cell.row, col: cell.col, initialText });
  }

  function finishEditing(move: CommitMove) {
    const editing = store.editing;
    store.stopEditing();
    focusGrid();
    if (!editing || move === "none") return;
    const next = navigate(collapsed({ row: editing.row, col: editing.col }), MOVE_KEYS[move], getBounds());
    if (next) {
      store.setSelection(next);
      scrollToCell(next.anchor);
    }
  }

  const context: GridEditing = {
    store,
    locale,
    timeZone,
    commit(value, move) {
      const editing = store.editing;
      const row = editing && store.getRowAt(editing.row);
      const column = editing && columns[editing.col];
      if (row && column && !sameValue(row.values[column.field.id], value)) {
        store.applyChanges(`edit of ${column.field.name}`, [
          { rowId: row.id, fieldId: column.field.id, before: row.values[column.field.id] ?? null, after: value, row: editing.row, col: editing.col },
        ]);
      }
      finishEditing(move);
    },
    cancel() {
      finishEditing("none");
    },
  };

  /** Clears every writable cell in the selection. Only loaded rows can be cleared from the client. */
  function clearSelection() {
    if (!store.selection) return;
    if (!canEdit) return store.announce("You have view-only access to this table");
    const { top, bottom, left, right } = rangeOf(store.selection);
    const changes: HistoryChange[] = [];
    for (let rowIndex = top; rowIndex <= bottom; rowIndex++) {
      const row = store.getRowAt(rowIndex);
      if (!row) return store.announce("Some selected rows aren't loaded yet; select fewer rows to clear them");
      for (let col = left; col <= right; col++) {
        const field = columns[col].field;
        if (isComputedField(field)) continue;
        const empty = field.type === "checkbox" ? false : null;
        if (!sameValue(row.values[field.id], empty)) {
          changes.push({ rowId: row.id, fieldId: field.id, before: row.values[field.id] ?? null, after: empty, row: rowIndex, col });
        }
      }
    }
    if (changes.length === 0) return;
    const label = `${changes.length} cleared ${changes.length === 1 ? "cell" : "cells"}`;
    store.applyChanges(label, changes);
    store.announce(`Cleared ${changes.length} ${changes.length === 1 ? "cell" : "cells"}`);
  }

  /** Undo/redo, then selects and scrolls to the changed cells, wherever they are. */
  function undoOrRedo(redo: boolean) {
    const entry = redo ? store.redo() : store.undo();
    if (!entry) return store.announce(redo ? "Nothing to redo" : "Nothing to undo");
    const rows = entry.changes.map((change) => change.row);
    const cols = entry.changes.map((change) => change.col);
    const anchor = { row: Math.min(...rows), col: Math.min(...cols) };
    store.setSelection({ anchor, focus: { row: Math.max(...rows), col: Math.max(...cols) } });
    scrollToCell(anchor);
  }

  /** Editing keys, used when the key wasn't a navigation key. */
  function handleKey(event: KeyboardEvent<HTMLElement>) {
    const mod = event.metaKey || event.ctrlKey;
    if (!store.editing && mod && (event.key.toLowerCase() === "z" || (event.ctrlKey && event.key.toLowerCase() === "y"))) {
      event.preventDefault();
      return undoOrRedo(event.key.toLowerCase() === "y" || event.shiftKey);
    }
    const active = store.selection?.anchor;
    if (!active || store.editing || event.nativeEvent.isComposing) return;
    if (event.key === "Enter" || event.key === "F2") {
      event.preventDefault();
      startEditing(active, null);
    } else if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      clearSelection();
    } else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      // Typing a character starts editing and replaces the value, as in a spreadsheet.
      event.preventDefault();
      startEditing(active, event.key);
    }
  }

  function onDoubleClick(event: MouseEvent<HTMLElement>) {
    const cell = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-row][data-col]") : null;
    if (cell) startEditing({ row: Number(cell.dataset.row), col: Number(cell.dataset.col) }, null);
  }

  return { context, handleKey, onDoubleClick };
}
