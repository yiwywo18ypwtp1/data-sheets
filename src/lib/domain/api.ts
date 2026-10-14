import type { CellValue } from "./cell";
import type { Row } from "./row";

/** Shapes of API responses, shared by the Route Handlers and the client code that calls them. */

/** The API's single error format. */
export type ErrorBody = {
  error: { code: string; message: string; fieldErrors?: Record<string, string>; details?: unknown };
};

/** Footer aggregates for numeric columns, over all rows matching the filter (not just the window). */
export type Aggregates = Record<string, { sum: number; avg: number | null }>;

/**
 * A group of the grouped result, in display order: each top-level group is followed by
 * its subgroups. `start`/`count` are positions in the ungrouped, sorted result.
 * `key` is the stored value the rows share (an option id, a date…), null for empty.
 */
export type RowGroup = { level: 0 | 1; fieldId: string; key: CellValue; start: number; count: number; aggregates: Aggregates };

export type RowWindow = { rows: Row[]; total: number; aggregates: Aggregates; groups?: RowGroup[] };

/** `GET /api/tables/:id/rows` */
export type RowWindowResponse = RowWindow & {
  offset: number;
  /** Primary values of records referenced by link cells in `rows`: `{ rowId: label }`. */
  linkedLabels: Record<string, string>;
};

/** One value written into a record's cell (`GET /api/tables/:id/rows/:rowId/history`). */
export type CellHistoryEntry = {
  id: number;
  fieldId: string;
  /** The value it replaced. */
  before: CellValue;
  after: CellValue;
  /** The record's revision after the write. */
  rev: number;
  by: { userId: string; name: string };
  at: string;
};

export type CellHistoryResponse = {
  entries: CellHistoryEntry[];
  /** Pass as `before` for the next (older) page; null at the end. */
  next: number | null;
  /** Labels of records in link values, like `RowWindowResponse.linkedLabels`. */
  linkedLabels: Record<string, string>;
};

/** `GET /api/tables/:id/rows/:rowId` */
export type RowResponse = { row: Row; linkedLabels: Record<string, string> };

/** One column of a kanban board: the option id (null: no value), how many cards match, and a page of them. */
export type KanbanColumnData = { key: string | null; count: number; rows: Row[] };

/** `GET /api/tables/:id/kanban` */
export type KanbanResponse = { columns: KanbanColumnData[]; total: number; linkedLabels: Record<string, string> };
