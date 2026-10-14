import "server-only";
import { isComputedField } from "@/lib/domain/field";
import { EMPTY_FILTER } from "@/lib/domain/filter";
import { defaultFormConfig, formConfigIssues } from "@/lib/domain/form";
import { newId } from "@/lib/domain/ids";
import { kanbanFields, kanbanFieldIssue, viewConfigSchemaFor, viewSchema, type View } from "@/lib/domain/view";
import { getDb } from "./db";
import { ApiError, notFound, zodFieldErrors } from "./errors";
import { appendEvent, type Origin } from "./events";
import { expireFormCache, formTags } from "./formCache";
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
  if (view.kind !== current.view.kind) throw new ApiError("VALIDATION_ERROR", 400, "A view's kind can't change");

  // Filters, sorts and hidden fields must refer to fields that exist now, with fitting operators.
  const table = getTable(current.tableId)!;
  const config = viewConfigSchemaFor(table.fields).safeParse(view);
  if (!config.success) throw new ApiError("VALIDATION_ERROR", 400, "Invalid view", { fieldErrors: zodFieldErrors(config.error.issues) });
  const fieldIds = new Set(table.fields.map((field) => field.id));
  const unknown = [...view.fieldOrder, ...Object.keys(view.columnWidths)].filter((id) => !fieldIds.has(id));
  if (unknown.length > 0) throw new ApiError("VALIDATION_ERROR", 400, `Unknown fields: ${unknown.join(", ")}`);
  if (view.kind === "kanban" && view.kanban) {
    const issue = kanbanFieldIssue(view.kanban.fieldId, table.fields);
    if (issue) throw new ApiError("VALIDATION_ERROR", 400, issue, { fieldErrors: { "kanban.fieldId": issue } });
  }
  if (view.kind === "form") {
    if (!view.form) throw new ApiError("VALIDATION_ERROR", 400, "A form view needs its form settings", { fieldErrors: { form: "Required" } });
    const issues = formConfigIssues(view.form, table.fields);
    if (issues.length > 0) {
      throw new ApiError("VALIDATION_ERROR", 400, issues[0].message, { fieldErrors: zodFieldErrors(issues.map((issue) => ({ ...issue, path: ["form", ...issue.path] }))) });
    }
  }

  const db = getDb();
  db.transaction(() => {
    db.prepare("UPDATE views SET config = ?, version = version + 1 WHERE id = ?").run(JSON.stringify(view), viewId);
    // Views are part of the table's metadata, so the table's ETag must change too.
    db.prepare("UPDATE tables SET version = version + 1 WHERE id = ?").run(current.tableId);
    appendEvent(current.tableId, { kind: "view", origin, view, version: current.version + 1 });
  })();
  if (view.kind === "form") expireFormCache(formTags.view(viewId));
  return { view, version: current.version + 1 };
}

/**
 * A new view at the end of the table's tabs: a grid showing every field, a form with a
 * few questions, or a board stacked by the table's first single select field.
 */
export function createView(tableId: string, input: { name: string; kind: View["kind"] }): View {
  const table = getTable(tableId);
  if (!table) throw notFound("Table");
  const stackBy = kanbanFields(table.fields)[0];
  if (input.kind === "kanban" && !stackBy) {
    throw new ApiError("VALIDATION_ERROR", 400, "A board needs a single select field: add one first", { fieldErrors: { kind: "No single select field" } });
  }
  const view: View = {
    id: newId("viw"),
    name: input.name,
    kind: input.kind,
    filter: EMPTY_FILTER,
    sorts: [],
    hiddenFieldIds: [],
    fieldOrder: table.fields.map((field) => field.id),
    columnWidths: {},
    rowHeight: "short",
    ...(input.kind === "form" ? { form: defaultFormConfig(table.name, table.fields.filter((field) => !isComputedField(field))) } : {}),
    ...(input.kind === "kanban" ? { kanban: { fieldId: stackBy.id } } : {}),
  };
  const db = getDb();
  const { position } = db.prepare("SELECT coalesce(max(position), -1) + 1 AS position FROM views WHERE table_id = ?").get(tableId) as { position: number };
  db.transaction(() => {
    db.prepare("INSERT INTO views (id, table_id, position, config, version) VALUES (?, ?, ?, ?, 1)").run(view.id, tableId, position, JSON.stringify(view));
    db.prepare("UPDATE tables SET version = version + 1 WHERE id = ?").run(tableId);
  })();
  return view;
}
