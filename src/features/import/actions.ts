"use server";

import { z } from "zod";
import { idSchema } from "@/lib/domain/ids";
import { assertRole, getCurrentUser } from "@/server/auth";
import { ApiError } from "@/server/errors";
import { importBatch, importRowsSchema, type ImportBatchResult } from "@/server/imports";
import { getTable } from "@/server/tables";

const inputSchema = z.object({
  tableId: idSchema,
  importId: idSchema,
  batchIndex: z.number().int().nonnegative().max(999_999),
  rows: importRowsSchema,
});

export type ImportBatchOutcome = { ok: true; result: ImportBatchResult } | { ok: false; message: string };

/**
 * Imports one batch of rows for the CSV wizard. Idempotent per (import, batch): the
 * wizard can retry a batch whose answer got lost without creating its rows twice.
 * Errors are returned, not thrown, so the wizard can show them and offer a retry.
 */
export async function importRowsAction(input: z.input<typeof inputSchema>): Promise<ImportBatchOutcome> {
  try {
    assertRole(await getCurrentUser(), "creator");
    const { tableId, importId, batchIndex, rows } = inputSchema.parse(input);
    const table = getTable(tableId);
    if (!table) return { ok: false, message: "The table no longer exists" };
    return { ok: true, result: importBatch(table, `${importId}:${batchIndex}`, rows) };
  } catch (error) {
    if (error instanceof ApiError) return { ok: false, message: error.message };
    if (error instanceof z.ZodError) return { ok: false, message: "The batch is invalid" };
    throw error;
  }
}
