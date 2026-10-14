import "server-only";
import type { CellValue } from "@/lib/domain/cell";
import type { CellHistoryEntry } from "@/lib/domain/api";
import { getDb } from "./db";
import type { Origin } from "./events";

/**
 * Cell history: every value a user writes into an existing record (an edit, a paste,
 * a fill, an undo) is logged with the value it replaced, who wrote it and the row's
 * `rev` after the write. Logged in the batch's transaction, so a rolled-back op leaves
 * no entry. Creates are not logged: the earliest entry's `before` is the value the
 * record was created with, and an import of 180 000 rows would otherwise write
 * millions of entries nobody reads. Recomputed formula and lookup cells aren't logged
 * either: they follow from the logged inputs.
 */

type HistoryRecord = { id: number; field_id: string; before: string | null; after: string | null; rev: number; user_id: string; user_name: string; at: string };

const toJson = (value: CellValue | undefined) => (value === null || value === undefined ? null : JSON.stringify(value));
const fromJson = (text: string | null): CellValue => (text === null ? null : (JSON.parse(text) as CellValue));

export function recordCellChanges(
  tableId: string,
  rowId: string,
  before: Record<string, CellValue>,
  written: Record<string, CellValue>,
  rev: number,
  origin: Origin,
  at: string,
): void {
  const insert = getDb().prepare(
    "INSERT INTO cell_history (table_id, row_id, field_id, before, after, rev, user_id, user_name, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const [fieldId, value] of Object.entries(written)) {
    const old = toJson(before[fieldId]);
    const next = toJson(value);
    // Writing the value a cell already has (a paste over identical data) isn't a change.
    if (old !== next) insert.run(tableId, rowId, fieldId, old, next, rev, origin.userId, origin.name, at);
  }
}

export const HISTORY_PAGE = 50;

/** A record's history, newest first, optionally for one field; `before` pages back from an entry id. */
export function cellHistory(tableId: string, rowId: string, options: { fieldId?: string; before?: number; limit?: number } = {}): { entries: CellHistoryEntry[]; next: number | null } {
  const limit = options.limit ?? HISTORY_PAGE;
  const records = getDb()
    .prepare(
      `SELECT id, field_id, before, after, rev, user_id, user_name, at FROM cell_history
       WHERE row_id = ? AND table_id = ? AND (? IS NULL OR field_id = ?) AND (? IS NULL OR id < ?)
       ORDER BY id DESC LIMIT ?`,
    )
    .all(rowId, tableId, options.fieldId ?? null, options.fieldId ?? null, options.before ?? null, options.before ?? null, limit + 1) as HistoryRecord[];
  const page = records.slice(0, limit);
  return {
    entries: page.map((record) => ({
      id: record.id,
      fieldId: record.field_id,
      before: fromJson(record.before),
      after: fromJson(record.after),
      rev: record.rev,
      by: { userId: record.user_id, name: record.user_name },
      at: record.at,
    })),
    next: records.length > limit ? page.at(-1)!.id : null,
  };
}

/** A deleted field's history means nothing any more. */
export function forgetFieldHistory(fieldId: string): void {
  getDb().prepare("DELETE FROM cell_history WHERE field_id = ?").run(fieldId);
}
