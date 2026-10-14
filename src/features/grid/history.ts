import type { CellValue } from "@/lib/domain/cell";

/** One cell changed by a user action, with where it was, to scroll back to it on undo. */
export type HistoryChange = { rowId: string; fieldId: string; before: CellValue; after: CellValue; row: number; col: number };

/** One undoable action: a cell edit, a cleared range, or a whole paste (one Cmd+Z undoes all of it). */
export type HistoryEntry = { label: string; changes: HistoryChange[] };

export const HISTORY_LIMIT = 100;

/** Undo/redo stacks for this session. A new action clears the redo stack, as everywhere else. */
export class History {
  private done: HistoryEntry[] = [];
  private undone: HistoryEntry[] = [];

  push(entry: HistoryEntry): void {
    if (entry.changes.length === 0) return;
    this.done.push(entry);
    if (this.done.length > HISTORY_LIMIT) this.done.shift();
    this.undone = [];
  }

  /** Returns the entry to undo (apply its `before` values), or null. */
  undo(): HistoryEntry | null {
    const entry = this.done.pop() ?? null;
    if (entry) this.undone.push(entry);
    return entry;
  }

  /** Returns the entry to redo (apply its `after` values), or null. */
  redo(): HistoryEntry | null {
    const entry = this.undone.pop() ?? null;
    if (entry) this.done.push(entry);
    return entry;
  }
}
