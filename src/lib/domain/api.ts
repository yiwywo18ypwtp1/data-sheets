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
