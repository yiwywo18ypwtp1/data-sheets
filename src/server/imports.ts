import "server-only";
import { z } from "zod";
import { cellValueSchema } from "@/lib/domain/cell";
import { idSchema, newId } from "@/lib/domain/ids";
import { now } from "./clock";
import { getDb } from "./db";
import { ApiError } from "./errors";
import type { Origin } from "./events";
import { applyRowBatch } from "./rowWrites";

/** Rows per import request; the client sends smaller batches when rows are wide. */
export const MAX_IMPORT_ROWS = 1000;

export const importRowsSchema = z.array(z.record(idSchema, cellValueSchema)).min(1).max(MAX_IMPORT_ROWS);

/** Idempotency keys look like `<importId>:<batchIndex>`. */
export const idempotencyKeySchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}:\d{1,6}$/, "Invalid Idempotency-Key");

export type ImportBatchResult = {
  imported: number;
  /** Rows the server rejected (index within the batch), e.g. a value that became invalid meanwhile. */
  failed: { index: number; message: string }[];
};

/**
 * Creates one batch of imported rows, at most once per idempotency key. The key and
 * the rows are written in the same transaction, so a retried batch (a lost response,
 * a double click, a reload) returns the stored result instead of importing twice.
 * Each row is validated like any other write; a row that fails is reported, not fatal.
 */
export function importBatch(table: { id: string; baseId: string }, key: string, rows: z.infer<typeof importRowsSchema>, origin?: Origin): ImportBatchResult {
  const db = getDb();
  return db.transaction(() => {
    const stored = db.prepare("SELECT table_id, result FROM import_batches WHERE key = ?").get(key) as { table_id: string; result: string } | undefined;
    if (stored) {
      if (stored.table_id !== table.id) throw new ApiError("CONFLICT", 409, "This Idempotency-Key was used for another table");
      return JSON.parse(stored.result) as ImportBatchResult;
    }
    const results = applyRowBatch(table, rows.map((values) => ({ op: "create", rowId: newId("row"), values })), origin);
    const result: ImportBatchResult = {
      imported: results.filter((entry) => entry.ok).length,
      failed: results.flatMap((entry, index) => {
        if (entry.ok) return [];
        const details = Object.entries(entry.error.fieldErrors ?? {}).map(([fieldId, message]) => `${fieldId}: ${message}`);
        return [{ index, message: [entry.error.message, ...details].join("; ") }];
      }),
    };
    db.prepare("INSERT INTO import_batches (key, table_id, result, created_at) VALUES (?, ?, ?, ?)").run(key, table.id, JSON.stringify(result), now().toISOString());
    return result;
  })();
}
