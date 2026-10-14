import { z } from "zod";
import { apiRoute, parseJsonBody } from "@/server/api";
import { assertRole, getCurrentUser, originOf } from "@/server/auth";
import { ApiError, notFound } from "@/server/errors";
import { idempotencyKeySchema, importBatch, importRowsSchema } from "@/server/imports";
import { getTable } from "@/server/tables";

/**
 * One batch of imported rows (`{ rows: [{ fieldId: value }] }`). Requires an
 * `Idempotency-Key: <importId>:<batchIndex>` header: repeating a batch returns the
 * first result instead of creating the rows again. The import wizard calls the same
 * code through a Server Action.
 */
export const POST = apiRoute(async (request, context: RouteContext<"/api/tables/[id]/import">) => {
  const user = await getCurrentUser();
  assertRole(user, "creator");
  const table = getTable((await context.params).id);
  if (!table) throw notFound("Table");
  const key = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
  if (!key.success) throw new ApiError("VALIDATION_ERROR", 400, "Idempotency-Key header like <importId>:<batchIndex> is required");
  const { rows } = await parseJsonBody(request, z.object({ rows: importRowsSchema }));
  return Response.json(importBatch(table, key.data, rows, originOf(user, request)));
});
