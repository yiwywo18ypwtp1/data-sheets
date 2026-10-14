import "server-only";
import type { Field } from "@/lib/domain/field";
import type { TableMeta } from "@/lib/domain/table";
import type { View } from "@/lib/domain/view";
import { getDb } from "./db";

/**
 * JSON columns are parsed with a cast, not a zod parse: everything in them was
 * validated on the way in, and re-validating 30 fields on every request buys nothing.
 */

type TableRecord = { id: string; base_id: string; name: string; primary_field_id: string; fields: string; version: number };
type ViewRecord = { id: string; table_id: string; config: string; version: number };

export type TableSummary = { id: string; name: string };
export type BaseSummary = { id: string; name: string; tables: TableSummary[] };

export function getBase(baseId: string): BaseSummary | null {
  const db = getDb();
  const base = db.prepare("SELECT id, name FROM bases WHERE id = ?").get(baseId) as { id: string; name: string } | undefined;
  if (!base) return null;
  const tables = db.prepare("SELECT id, name FROM tables WHERE base_id = ? ORDER BY position").all(baseId) as TableSummary[];
  return { ...base, tables };
}

export function getFirstBaseId(): string | null {
  const row = getDb().prepare("SELECT id FROM bases ORDER BY rowid LIMIT 1").get() as { id: string } | undefined;
  return row?.id ?? null;
}

export function getTable(tableId: string): (TableMeta & { baseId: string }) | null {
  const db = getDb();
  const table = db.prepare("SELECT * FROM tables WHERE id = ?").get(tableId) as TableRecord | undefined;
  if (!table) return null;
  const views = db.prepare("SELECT config FROM views WHERE table_id = ? ORDER BY position").all(tableId) as Pick<ViewRecord, "config">[];
  return {
    id: table.id,
    baseId: table.base_id,
    name: table.name,
    primaryFieldId: table.primary_field_id,
    fields: JSON.parse(table.fields) as Field[],
    views: views.map((view) => JSON.parse(view.config) as View),
    version: table.version,
  };
}

/** A view together with its table and optimistic-concurrency version (used for `If-Match`). */
export function getView(viewId: string): { view: View; tableId: string; version: number } | null {
  const record = getDb().prepare("SELECT * FROM views WHERE id = ?").get(viewId) as ViewRecord | undefined;
  if (!record) return null;
  return { view: JSON.parse(record.config) as View, tableId: record.table_id, version: record.version };
}

/** Fields of every table in the base: the formula dependency graph spans tables through lookups. */
export function getBaseFields(baseId: string): Field[] {
  const records = getDb().prepare("SELECT fields FROM tables WHERE base_id = ?").all(baseId) as Pick<TableRecord, "fields">[];
  return records.flatMap((record) => JSON.parse(record.fields) as Field[]);
}
