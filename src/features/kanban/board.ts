import type { KanbanColumnData } from "@/lib/domain/api";
import type { Row } from "@/lib/domain/row";

/**
 * The board's columns as loaded: a page of cards per column and the column's full count.
 * Pure functions, so moves are unit-tested without a DOM.
 */
export type Columns = KanbanColumnData[];

export function findCard(columns: Columns, rowId: string): { column: number; index: number; row: Row } | null {
  for (let column = 0; column < columns.length; column++) {
    const index = columns[column].rows.findIndex((row) => row.id === rowId);
    if (index >= 0) return { column, index, row: columns[column].rows[index] };
  }
  return null;
}

/**
 * Moves a card to another column, optimistically: it goes to the top of the target
 * (where it's seen; the server's sort places it after the next reload), the stacking
 * field takes the column's value, and both counts change. Null if nothing would move.
 */
export function moveCard(columns: Columns, rowId: string, fieldId: string, toKey: string | null): Columns | null {
  const found = findCard(columns, rowId);
  const target = columns.findIndex((column) => column.key === toKey);
  if (!found || target < 0 || found.column === target) return null;
  const moved: Row = { ...found.row, values: { ...found.row.values, [fieldId]: toKey } };
  return columns.map((column, i) => {
    if (i === found.column) return { ...column, count: column.count - 1, rows: column.rows.filter((row) => row.id !== rowId) };
    if (i === target) return { ...column, count: column.count + 1, rows: [moved, ...column.rows] };
    return column;
  });
}

/** Replaces a card with the server's version of it (after a write), wherever it is. */
export function replaceCard(columns: Columns, row: Row): Columns {
  const found = findCard(columns, row.id);
  if (!found) return columns;
  return columns.map((column, i) => (i === found.column ? { ...column, rows: column.rows.map((candidate) => (candidate.id === row.id ? row : candidate)) } : column));
}

/** Appends a page of a column's cards ("Show more"), skipping any already there. */
export function appendCards(columns: Columns, key: string | null, rows: Row[], count: number): Columns {
  return columns.map((column) => {
    if (column.key !== key) return column;
    const known = new Set(column.rows.map((row) => row.id));
    return { ...column, count, rows: [...column.rows, ...rows.filter((row) => !known.has(row.id))] };
  });
}

/** The column `step` places left or right of the card's, for moving with the keyboard. */
export function neighbourKey(columns: Columns, rowId: string, step: -1 | 1): string | null | undefined {
  const found = findCard(columns, rowId);
  if (!found) return undefined;
  const target = columns[found.column + step];
  return target ? target.key : undefined;
}
