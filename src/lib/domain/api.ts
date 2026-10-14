import type { Row } from "./row";

/** Shapes of API responses, shared by the Route Handlers and the client code that calls them. */

/** The API's single error format. */
export type ErrorBody = {
  error: { code: string; message: string; fieldErrors?: Record<string, string>; details?: unknown };
};

/** Footer aggregates for numeric columns, over all rows matching the filter (not just the window). */
export type Aggregates = Record<string, { sum: number; avg: number | null }>;

export type RowWindow = { rows: Row[]; total: number; aggregates: Aggregates };

/** `GET /api/tables/:id/rows` */
export type RowWindowResponse = RowWindow & {
  offset: number;
  /** Primary values of records referenced by link cells in `rows`: `{ rowId: label }`. */
  linkedLabels: Record<string, string>;
};
