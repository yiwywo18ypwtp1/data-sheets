import "server-only";
import type { CellValue } from "@/lib/domain/cell";
import type { Row } from "@/lib/domain/row";

/** How a row is stored in the `rows` table. */
export type RowRecord = {
  id: string;
  table_id: string;
  seq: number;
  rev: number;
  created_at: string;
  updated_at: string;
  cells: string;
  errors: string | null;
};

export function toRow(record: RowRecord): Row {
  const row: Row = {
    id: record.id,
    values: JSON.parse(record.cells) as Record<string, CellValue>,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    rev: record.rev,
  };
  if (record.errors) row.errors = JSON.parse(record.errors) as Record<string, string>;
  return row;
}

/** Drops null cells: an absent key means empty, which keeps 50 000 JSON rows smaller. */
export function serializeCells(values: Record<string, CellValue>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(values).filter(([, value]) => value !== null)));
}

export function serializeErrors(errors: Record<string, string>): string | null {
  return Object.keys(errors).length > 0 ? JSON.stringify(errors) : null;
}
