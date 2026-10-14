import "server-only";
import { viewConfigSchemaFor, viewSchema, type View } from "@/lib/domain/view";
import { getDb } from "./db";
import { ApiError, notFound, zodFieldErrors } from "./errors";
import { appendEvent, type Origin } from "./events";
import { SYSTEM_ORIGIN } from "./rowWrites";
import { getTable, getView } from "./tables";

/**
 * Saves a whole view with optimistic concurrency: the caller sends the version it
 * edited (`If-Match`). If someone saved in between, nothing is written and the
 * caller gets 412 with the current view, instead of silently overwriting it.
 */
export function saveView(viewId: string, input: unknown, expectedVersion: number | null, origin: Origin = SYSTEM_ORIGIN): { view: View; version: number } {
  const current = getView(viewId);
  if (!current) throw notFound("View");
  if (expectedVersion === null) {
    throw new ApiError("PRECONDITION_FAILED", 428, "If-Match header with the view version is required");
  }
  if (expectedVersion !== current.version) {
    throw new ApiError("PRECONDITION_FAILED", 412, "The view was changed by someone else", {
      details: { view: current.view, version: current.version },
    });
  }

  const parsed = viewSchema.safeParse(input);
  if (!parsed.success) throw new ApiError("VALIDATION_ERROR", 400, "Invalid view", { fieldErrors: zodFieldErrors(parsed.error.issues) });
  const view = parsed.data;
  if (view.id !== viewId) throw new ApiError("VALIDATION_ERROR", 400, "View id doesn't match the URL");

  // Filters, sorts and hidden fields must refer to fields that exist now, with fitting operators.
  const table = getTable(current.tableId)!;
  const config = viewConfigSchemaFor(table.fields).safeParse(view);
  if (!config.success) throw new ApiError("VALIDATION_ERROR", 400, "Invalid view", { fieldErrors: zodFieldErrors(config.error.issues) });
  const fieldIds = new Set(table.fields.map((field) => field.id));
  const unknown = [...view.fieldOrder, ...Object.keys(view.columnWidths)].filter((id) => !fieldIds.has(id));
  if (unknown.length > 0) throw new ApiError("VALIDATION_ERROR", 400, `Unknown fields: ${unknown.join(", ")}`);

  const db = getDb();
  db.transaction(() => {
    db.prepare("UPDATE views SET config = ?, version = version + 1 WHERE id = ?").run(JSON.stringify(view), viewId);
    // Views are part of the table's metadata, so the table's ETag must change too.
    db.prepare("UPDATE tables SET version = version + 1 WHERE id = ?").run(current.tableId);
    appendEvent(current.tableId, { kind: "view", origin, view, version: current.version + 1 });
  })();
  return { view, version: current.version + 1 };
}
