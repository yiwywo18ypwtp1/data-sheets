import { z } from "zod";
import { cellValueSchema } from "./cell";
import { idSchema } from "./ids";

/**
 * `rev` grows by one on every write and is used to detect concurrent edits of the same row.
 * `errors` is an addition to the task's Row type: a formula that fails (`#DIV/0!`) stores
 * `null` in `values`, so filters treat it as empty, and the message here, so the grid can show it.
 */
export const rowSchema = z.object({
  id: idSchema,
  values: z.record(idSchema, cellValueSchema),
  errors: z.record(idSchema, z.string()).optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  rev: z.number().int().nonnegative(),
});
export type Row = z.infer<typeof rowSchema>;

const rowValues = z.record(idSchema, cellValueSchema);

/**
 * Batch operations only check the structure here. Values are checked per field
 * on the server with `cellValueSchemaFor`, because that needs the table schema.
 * `create` carries a client-generated id so an optimistic row keeps its identity.
 */
export const rowOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("create"), rowId: idSchema, values: rowValues }),
  z.object({ op: z.literal("update"), rowId: idSchema, values: rowValues, rev: z.number().int().nonnegative() }),
  z.object({ op: z.literal("delete"), rowId: idSchema, rev: z.number().int().nonnegative() }),
]);
export type RowOp = z.infer<typeof rowOpSchema>;

export const MAX_BATCH_OPS = 1000;

export const rowBatchSchema = z.object({
  ops: z.array(rowOpSchema).min(1).max(MAX_BATCH_OPS),
});
export type RowBatch = z.infer<typeof rowBatchSchema>;

/** Results come back in the same order as the ops, so a failure can be rolled back per op. */
export type RowOpResult =
  | { ok: true; rowId: string; row: Row | null } // `row` is null for a delete
  | { ok: false; rowId: string; error: { code: string; message: string; fieldErrors?: Record<string, string> } };
