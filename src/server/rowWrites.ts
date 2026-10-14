import "server-only";
import type { z } from "zod";
import { cellValueSchemaFor, type CellValue } from "@/lib/domain/cell";
import { isComputedField, type Field } from "@/lib/domain/field";
import type { Row, RowOp, RowOpResult } from "@/lib/domain/row";
import { buildDependencyGraph, dependentsOf, topologicalOrder, type DependencyGraph } from "@/lib/formula/graph";
import { now } from "./clock";
import { appendEvent, type Origin, type RowChange } from "./events";
import { computeFields, FormulaCache, type ComputedResult, type LinkedValuesReader } from "./compute";
import { getDb } from "./db";
import { recordCellChanges } from "./history";
import { getRowsByIds, markRowsChanged } from "./rows";
import { serializeCells, serializeErrors, toRow, type RowRecord } from "./storage";
import { getBaseSchema } from "./tables";

/** Cross-table recompute can't legitimately chain deeper than this (cycles are rejected on save). */
const MAX_PROPAGATION_DEPTH = 10;

type OpError = Extract<RowOpResult, { ok: false }>["error"];
class OpFailure extends Error {
  constructor(readonly error: OpError) {
    super(error.message);
  }
}

/** Rows touched in one table, and which of their fields changed. */
type TableChanges = { rowIds: Set<string>; fieldIds: Set<string> };

/** Changes a batch made, per table, for the realtime event log. */
class ChangeLog {
  private readonly touched = new Map<string, Map<string, { fields: Set<string>; created: boolean }>>();
  private readonly deleted = new Map<string, Set<string>>();

  /** `fields` are the cells written directly; recomputed cells don't count (no conflicts on them). */
  touch(tableId: string, rowId: string, fields: Iterable<string>, created = false) {
    if (!this.touched.has(tableId)) this.touched.set(tableId, new Map());
    const rows = this.touched.get(tableId)!;
    const entry = rows.get(rowId) ?? { fields: new Set<string>(), created };
    for (const field of fields) entry.fields.add(field);
    rows.set(rowId, entry);
  }

  remove(tableId: string, rowId: string) {
    if (!this.deleted.has(tableId)) this.deleted.set(tableId, new Set());
    this.deleted.get(tableId)!.add(rowId);
    this.touched.get(tableId)?.delete(rowId);
  }

  /** One event per changed table, with the rows as they are at the end of the batch. */
  emit(origin: Origin) {
    for (const tableId of new Set([...this.touched.keys(), ...this.deleted.keys()])) {
      const entries = this.touched.get(tableId) ?? new Map<string, { fields: Set<string>; created: boolean }>();
      const rows: RowChange[] = getRowsByIds(tableId, [...entries.keys()]).map((row) => {
        const entry = entries.get(row.id)!;
        return { row, fields: [...entry.fields], ...(entry.created ? { created: true as const } : {}) };
      });
      const deleted = [...(this.deleted.get(tableId) ?? [])];
      if (rows.length > 0 || deleted.length > 0) appendEvent(tableId, { kind: "rows", origin, rows, deleted });
    }
  }
}

/** Changes made by the server itself (seeding, recomputes) rather than a user. */
export const SYSTEM_ORIGIN: Origin = { userId: "system", name: "System", clientId: null };

/** Everything a batch needs about the base, loaded once per batch. */
class BatchContext {
  readonly log = new ChangeLog();
  readonly fields: Map<string, Field>;
  readonly tableOfField: Map<string, string>;
  readonly fieldsOfTable: Map<string, Field[]>;
  readonly graph: DependencyGraph;
  readonly formulas: FormulaCache;
  readonly evalContext = { now: now() };
  readonly timestamp = this.evalContext.now.toISOString();
  private readonly schemas = new Map<string, z.ZodType<CellValue>>();

  constructor(
    baseId: string,
    /** Who writes: for the event log and the cell history. */
    readonly origin: Origin = SYSTEM_ORIGIN,
  ) {
    const schema = getBaseSchema(baseId);
    this.fields = new Map(schema.flatMap((table) => table.fields.map((field) => [field.id, field] as const)));
    this.tableOfField = new Map(schema.flatMap((table) => table.fields.map((field) => [field.id, table.tableId] as const)));
    this.fieldsOfTable = new Map(schema.map((table) => [table.tableId, table.fields]));
    this.graph = buildDependencyGraph(this.fields.values());
    this.formulas = new FormulaCache(this.fields);
  }

  valueSchema(field: Field): z.ZodType<CellValue> {
    let schema = this.schemas.get(field.id);
    if (!schema) {
      schema = cellValueSchemaFor(field);
      this.schemas.set(field.id, schema);
    }
    return schema;
  }

  /** Computed fields of `tableId` that must be recomputed when `dirtyIds` change, in dependency order. */
  recomputeOrder(tableId: string, dirtyIds: Iterable<string>): string[] {
    const dirty = new Set(dirtyIds);
    const candidates = [...dirtyIds, ...dependentsOf(this.graph, dirty)].filter((id) => {
      const field = this.fields.get(id);
      return field !== undefined && isComputedField(field) && this.tableOfField.get(id) === tableId;
    });
    return topologicalOrder(this.graph, new Set(candidates));
  }
}

const readLinked: LinkedValuesReader = (tableId, rowIds, fieldId) =>
  getRowsByIds(tableId, rowIds).map((row) => row.values[fieldId] ?? null);

/** Validates written values against their fields; returns per-field messages on failure. */
function validateValues(tableId: string, values: Record<string, CellValue>, batch: BatchContext): Record<string, CellValue> {
  const fieldErrors: Record<string, string> = {};
  const clean: Record<string, CellValue> = {};

  for (const [fieldId, value] of Object.entries(values)) {
    const field = batch.fields.get(fieldId);
    if (!field || batch.tableOfField.get(fieldId) !== tableId) {
      fieldErrors[fieldId] = "Field does not exist";
      continue;
    }
    const parsed = batch.valueSchema(field).safeParse(value);
    if (!parsed.success) {
      fieldErrors[fieldId] = parsed.error.issues[0]?.message ?? "Invalid value";
      continue;
    }
    if (field.type === "link" && Array.isArray(parsed.data) && parsed.data.length > 0) {
      const existing = getRowsByIds(field.targetTableId, parsed.data);
      if (existing.length !== parsed.data.length) {
        fieldErrors[fieldId] = "Linked record does not exist";
        continue;
      }
    }
    clean[fieldId] = parsed.data;
  }

  if (Object.keys(fieldErrors).length > 0) {
    throw new OpFailure({ code: "VALIDATION_ERROR", message: "Some values are invalid", fieldErrors });
  }
  return clean;
}

function loadRow(tableId: string, rowId: string): RowRecord | undefined {
  return getDb().prepare("SELECT * FROM rows WHERE table_id = ? AND id = ?").get(tableId, rowId) as RowRecord | undefined;
}

function saveRow(record: RowRecord, computed: ComputedResult, timestamp: string): Row {
  getDb()
    .prepare("UPDATE rows SET cells = ?, errors = ?, rev = rev + 1, updated_at = ? WHERE id = ?")
    .run(serializeCells(computed.values), serializeErrors(computed.errors), timestamp, record.id);
  return toRow(loadRow(record.table_id, record.id)!);
}

function addChanges(changes: Map<string, TableChanges>, tableId: string, rowIds: Iterable<string>, fieldIds: Iterable<string>) {
  let entry = changes.get(tableId);
  if (!entry) {
    entry = { rowIds: new Set(), fieldIds: new Set() };
    changes.set(tableId, entry);
  }
  for (const id of rowIds) entry.rowIds.add(id);
  for (const id of fieldIds) entry.fieldIds.add(id);
}

/**
 * A restored record (undo of a delete) goes back between the records created just before
 * and after it, so it reappears where it was in creation order. `seq` may become fractional.
 */
function restoredSeq(tableId: string, createdAt: string): number {
  const { before, after } = getDb()
    .prepare(
      `SELECT (SELECT coalesce(max(seq), 0) FROM rows WHERE table_id = ? AND created_at < ?) AS before,
              (SELECT min(seq) FROM rows WHERE table_id = ? AND created_at > ?) AS after`,
    )
    .get(tableId, createdAt, tableId, createdAt) as { before: number; after: number | null };
  return after === null ? before + 1 : (before + after) / 2;
}

function createRow(tableId: string, op: Extract<RowOp, { op: "create" }>, batch: BatchContext): Row {
  // Ids are global, not per table: a client-generated id must not collide anywhere.
  if (getDb().prepare("SELECT 1 FROM rows WHERE id = ?").get(op.rowId)) {
    throw new OpFailure({ code: "CONFLICT", message: "A row with this id already exists" });
  }
  const values = validateValues(tableId, op.values, batch);
  const allComputed = (batch.fieldsOfTable.get(tableId) ?? []).filter(isComputedField).map((field) => field.id);
  const computed = computeFields(
    topologicalOrder(batch.graph, new Set(allComputed)),
    { values, errors: {} },
    batch.fields,
    batch.formulas,
    readLinked,
    batch.evalContext,
  );
  const seq = op.createdAt ? restoredSeq(tableId, op.createdAt) : (getDb().prepare("SELECT coalesce(max(seq), 0) + 1 AS seq FROM rows WHERE table_id = ?").get(tableId) as { seq: number }).seq;
  getDb()
    .prepare("INSERT INTO rows (id, table_id, seq, rev, created_at, updated_at, cells, errors) VALUES (?, ?, ?, 1, ?, ?, ?, ?)")
    .run(op.rowId, tableId, seq, op.createdAt ?? batch.timestamp, batch.timestamp, serializeCells(computed.values), serializeErrors(computed.errors));
  batch.log.touch(tableId, op.rowId, Object.keys(values), true);
  // A brand-new row isn't linked from anywhere yet, so nothing else needs recomputing.
  return toRow(loadRow(tableId, op.rowId)!);
}

/**
 * Cell-level last-write-wins: only the fields in `values` are replaced, so two users
 * editing different cells of one row both keep their edit. `rev` is returned so the
 * client can tell its edit was based on an older version (conflict UI is Advanced).
 */
function updateRow(tableId: string, op: Extract<RowOp, { op: "update" }>, batch: BatchContext, changes: Map<string, TableChanges>): Row {
  const record = loadRow(tableId, op.rowId);
  if (!record) throw new OpFailure({ code: "NOT_FOUND", message: "Row not found (it may have been deleted)" });
  const values = validateValues(tableId, op.values, batch);

  const current = toRow(record);
  const order = batch.recomputeOrder(tableId, Object.keys(values));
  const computed = computeFields(
    order,
    { values: { ...current.values, ...values }, errors: current.errors ?? {} },
    batch.fields,
    batch.formulas,
    readLinked,
    batch.evalContext,
  );
  const row = saveRow(record, computed, batch.timestamp);
  recordCellChanges(tableId, row.id, current.values, values, row.rev, batch.origin, batch.timestamp);
  addChanges(changes, tableId, [row.id], [...Object.keys(values), ...order]);
  batch.log.touch(tableId, row.id, Object.keys(values));
  return row;
}

function deleteRow(tableId: string, op: Extract<RowOp, { op: "delete" }>, deleted: Map<string, Set<string>>, batch: BatchContext): void {
  const result = getDb().prepare("DELETE FROM rows WHERE table_id = ? AND id = ?").run(tableId, op.rowId);
  if (result.changes === 0) throw new OpFailure({ code: "NOT_FOUND", message: "Row not found (it may have been deleted)" });
  batch.log.remove(tableId, op.rowId);
  if (!deleted.has(tableId)) deleted.set(tableId, new Set());
  deleted.get(tableId)!.add(op.rowId);
}

/** Rows of `tableId` whose `linkFieldId` points at any of `targetIds`. Scans the table's JSON; fine at this size. */
function rowsLinkingTo(tableId: string, linkFieldId: string, targetIds: string[]): RowRecord[] {
  return getDb()
    .prepare(
      `SELECT * FROM rows WHERE table_id = ? AND EXISTS (
         SELECT 1 FROM json_each(cells, ?) WHERE value IN (${targetIds.map(() => "?").join(", ")})
       )`,
    )
    .all(tableId, `$."${linkFieldId}"`, ...targetIds) as RowRecord[];
}

/** Deleted records disappear from every link that pointed at them (and their lookups update). */
function unlinkDeletedRows(deleted: Map<string, Set<string>>, batch: BatchContext, changes: Map<string, TableChanges>) {
  for (const [targetTableId, deletedIds] of deleted) {
    for (const field of batch.fields.values()) {
      if (field.type !== "link" || field.targetTableId !== targetTableId) continue;
      const tableId = batch.tableOfField.get(field.id)!;
      for (const record of rowsLinkingTo(tableId, field.id, [...deletedIds])) {
        const row = toRow(record);
        const remaining = (row.values[field.id] as string[]).filter((id) => !deletedIds.has(id));
        const order = batch.recomputeOrder(tableId, [field.id]);
        const computed = computeFields(
          order,
          { values: { ...row.values, [field.id]: remaining.length > 0 ? remaining : null }, errors: row.errors ?? {} },
          batch.fields,
          batch.formulas,
          readLinked,
          batch.evalContext,
        );
        saveRow(record, computed, batch.timestamp);
        addChanges(changes, tableId, [row.id], [field.id, ...order]);
        batch.log.touch(tableId, row.id, []);
      }
    }
  }
}

/**
 * Recomputes lookups (and the formulas on top of them) in rows that link to changed
 * rows, table by table, until nothing else depends on the changes. Runs once per
 * batch over all accumulated changes, so 1 000 edits cost one scan, not 1 000.
 */
function propagate(initial: Map<string, TableChanges>, batch: BatchContext) {
  let pending = initial;
  for (let depth = 0; pending.size > 0 && depth < MAX_PROPAGATION_DEPTH; depth++) {
    const next = new Map<string, TableChanges>();
    for (const [changedTableId, { rowIds, fieldIds }] of pending) {
      for (const lookup of batch.fields.values()) {
        if (lookup.type !== "lookup" || !fieldIds.has(lookup.targetFieldId)) continue;
        const link = batch.fields.get(lookup.linkFieldId);
        if (link?.type !== "link" || link.targetTableId !== changedTableId) continue;

        const tableId = batch.tableOfField.get(lookup.id)!;
        const order = batch.recomputeOrder(tableId, [lookup.id]);
        for (const record of rowsLinkingTo(tableId, link.id, [...rowIds])) {
          const row = toRow(record);
          const computed = computeFields(order, { values: row.values, errors: row.errors ?? {} }, batch.fields, batch.formulas, readLinked, batch.evalContext);
          saveRow(record, computed, batch.timestamp);
          addChanges(next, tableId, [row.id], order);
          batch.log.touch(tableId, row.id, []);
        }
      }
      markRowsChanged(changedTableId);
    }
    pending = next;
  }
}

/**
 * Applies up to 1 000 create/update/delete ops in one transaction. Each op succeeds
 * or fails on its own (partial result): a failed op is rolled back to its savepoint
 * and reported, the others are kept. Results are in the same order as the ops.
 */
export function applyRowBatch(table: { id: string; baseId: string }, ops: RowOp[], origin: Origin = SYSTEM_ORIGIN): RowOpResult[] {
  const db = getDb();
  const batch = new BatchContext(table.baseId, origin);
  const changes = new Map<string, TableChanges>();
  const deleted = new Map<string, Set<string>>();

  return db.transaction(() => {
    const results = ops.map((op): RowOpResult => {
      try {
        // A nested transaction is a savepoint: a throwing op undoes only its own writes.
        const row = db.transaction(() => {
          if (op.op === "create") return createRow(table.id, op, batch);
          if (op.op === "update") return updateRow(table.id, op, batch, changes);
          deleteRow(table.id, op, deleted, batch);
          return null;
        })();
        return { ok: true, rowId: op.rowId, row };
      } catch (error) {
        if (error instanceof OpFailure) return { ok: false, rowId: op.rowId, error: error.error };
        throw error;
      }
    });

    unlinkDeletedRows(deleted, batch, changes);
    markRowsChanged(table.id);
    propagate(changes, batch);
    batch.log.emit(batch.origin);
    return results;
  })();
}

/**
 * Recomputes the given computed fields, and everything that depends on them, in every
 * row of every affected table. Used after schema changes: a new or edited formula or
 * lookup, or a deleted field whose dependents now show `#REF!`.
 *
 * The fields are computed in dependency order, split into consecutive runs per table,
 * so a lookup in Orders that reads a Customers formula sees the new formula values.
 * Returns the tables whose rows changed.
 */
export function recomputeAllRows(baseId: string, fieldIds: string[]): string[] {
  const db = getDb();
  const batch = new BatchContext(baseId);
  const affected = new Set([...fieldIds, ...dependentsOf(batch.graph, new Set(fieldIds))]);
  const order = topologicalOrder(batch.graph, affected).filter((id) => {
    const field = batch.fields.get(id);
    return field !== undefined && isComputedField(field);
  });

  const runs: { tableId: string; fieldIds: string[] }[] = [];
  for (const id of order) {
    const tableId = batch.tableOfField.get(id)!;
    const last = runs.at(-1);
    if (last?.tableId === tableId) last.fieldIds.push(id);
    else runs.push({ tableId, fieldIds: [id] });
  }

  db.transaction(() => {
    const update = db.prepare("UPDATE rows SET cells = ?, errors = ?, rev = rev + 1, updated_at = ? WHERE id = ?");
    for (const run of runs) {
      const records = db.prepare("SELECT * FROM rows WHERE table_id = ?").all(run.tableId) as RowRecord[];
      for (const record of records) {
        const row = toRow(record);
        const computed = computeFields(run.fieldIds, { values: row.values, errors: row.errors ?? {} }, batch.fields, batch.formulas, readLinked, batch.evalContext);
        update.run(serializeCells(computed.values), serializeErrors(computed.errors), batch.timestamp, record.id);
      }
      markRowsChanged(run.tableId);
    }
  })();
  return [...new Set(runs.map((run) => run.tableId))];
}
