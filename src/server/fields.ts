import "server-only";
import { fieldSchema, isComputedField, type Field, type FormulaResultType } from "@/lib/domain/field";
import { newId } from "@/lib/domain/ids";
import { tableMetaSchema, type TableMeta } from "@/lib/domain/table";
import type { View } from "@/lib/domain/view";
import { compileFormula, type CompiledFormula } from "@/lib/formula/compile";
import { buildDependencyGraph, fieldDependencies, findCycle } from "@/lib/formula/graph";
import { FormulaSyntaxError } from "@/lib/formula/lexer";
import { fieldByNameResolver, toDisplayExpression, toStoredExpression } from "@/lib/formula/references";
import { getDb } from "./db";
import { ApiError, notFound, zodFieldErrors } from "./errors";
import { appendEvent, type Origin } from "./events";
import { recomputeAllRows, SYSTEM_ORIGIN } from "./rowWrites";
import { getBaseSchema, getTable } from "./tables";

/**
 * Schema changes (Core: create, rename/edit without changing type, delete).
 * Formulas arrive with field *names* (`{Price}`), as typed in the editor, and are
 * stored with ids. Every change is validated against the whole base, because
 * lookups and formulas can form cycles across tables.
 */

type Table = TableMeta & { baseId: string };

function requireTable(tableId: string): Table {
  const table = getTable(tableId);
  if (!table) throw notFound("Table");
  return table;
}

function validationError(message: string, fieldErrors: Record<string, string>, details?: unknown): ApiError {
  return new ApiError("VALIDATION_ERROR", 400, message, { fieldErrors, details });
}

/** Formula syntax errors become a 400 pointing at `expression`; anything else is rethrown as is. */
function formulaApiError(error: unknown): unknown {
  return error instanceof FormulaSyntaxError
    ? validationError("Invalid formula", { expression: error.message }, { position: error.position })
    : error;
}

/** All fields of the base with `field` added or replacing the field with the same id. */
function baseFieldsWith(baseId: string, field: Field): Field[] {
  const fields = getBaseSchema(baseId).flatMap((table) => table.fields.filter((existing) => existing.id !== field.id));
  return [...fields, field];
}

function cyclePath(baseId: string, field: Field): string[] | null {
  const fields = baseFieldsWith(baseId, field);
  const cycle = findCycle(buildDependencyGraph(fields), field.id);
  if (!cycle) return null;
  const names = new Map(fields.map((candidate) => [candidate.id, candidate.name]));
  return cycle.map((id) => names.get(id) ?? id);
}

/**
 * Turns user input into a valid field of `table`: resolves formula names to ids and
 * infers the result type, then checks the field itself, the table (unique names,
 * lookup uses a link), cross-table references, and cycles.
 */
function prepareField(table: Table, input: Record<string, unknown>, existing?: Field): Field {
  const candidate: Record<string, unknown> = { ...input };
  // A formula or lookup that a deleted field broke (#REF!) can still be renamed while its definition stays as is.
  const keepsFormula = existing?.type === "formula" && candidate.expression === toDisplayExpression(existing.expression, table.fields);
  const keepsLookup = existing?.type === "lookup" && candidate.linkFieldId === existing.linkFieldId && candidate.targetFieldId === existing.targetFieldId;

  if (keepsFormula) {
    candidate.expression = existing.expression;
  } else if (candidate.type === "formula" && typeof candidate.expression === "string") {
    try {
      // Names resolve against the table as it will be, so a renamed formula can't hide a self-reference.
      const fieldsForNames: Field[] = table.fields.filter((field) => field.id !== candidate.id);
      if (typeof candidate.name === "string" && typeof candidate.id === "string") {
        fieldsForNames.push({ id: candidate.id, name: candidate.name.trim(), type: "text" });
      }
      const compiled: CompiledFormula = compileFormula(candidate.expression, fieldByNameResolver(fieldsForNames));
      candidate.expression = toStoredExpression(candidate.expression, fieldsForNames);
      candidate.resultType = compiled.resultType;
    } catch (error) {
      throw formulaApiError(error);
    }
  }

  const parsed = fieldSchema.safeParse(candidate);
  if (!parsed.success) throw validationError("Invalid field", zodFieldErrors(parsed.error.issues));
  const field = parsed.data;

  const fields = table.fields.some((existing) => existing.id === field.id)
    ? table.fields.map((existing) => (existing.id === field.id ? field : existing))
    : [...table.fields, field];
  // Only problems this change introduces count. A lookup left broken by a force-deleted
  // link field (it shows #REF!) must not block every later change to the table.
  const issueKey = (issue: { path: PropertyKey[]; message: string }) => JSON.stringify([issue.path.map(String), issue.message]);
  const existingIssues = new Set(tableMetaSchema.safeParse(table).error?.issues.map(issueKey));
  const newIssues = (tableMetaSchema.safeParse({ ...table, fields }).error?.issues ?? []).filter((issue) => !existingIssues.has(issueKey(issue)));
  if (newIssues.length > 0) {
    const index = fields.indexOf(field);
    // A duplicate name is reported on whichever of the two fields comes second; it's still this field's name.
    const fieldErrors = zodFieldErrors(
      newIssues.map((issue) => ({ ...issue, path: issue.path[1] === index ? issue.path.slice(2) : [issue.path.at(-1) ?? "_"] })),
    );
    throw validationError(newIssues[0].message, fieldErrors);
  }

  const baseTables = getBaseSchema(table.baseId);
  if (field.type === "link" && !baseTables.some((candidateTable) => candidateTable.tableId === field.targetTableId)) {
    throw validationError("Linked table does not exist", { targetTableId: "Linked table does not exist" });
  }
  if (field.type === "lookup" && !keepsLookup) {
    const link = fields.find((candidateField) => candidateField.id === field.linkFieldId);
    const target = link?.type === "link" ? baseTables.find((candidateTable) => candidateTable.tableId === link.targetTableId) : undefined;
    if (!target?.fields.some((targetField) => targetField.id === field.targetFieldId)) {
      throw validationError("Lookup field must belong to the linked table", { targetFieldId: "Pick a field of the linked table" });
    }
  }

  const cycle = cyclePath(table.baseId, field);
  if (cycle) {
    const message = `Circular reference: ${cycle.join(" → ")}`;
    throw validationError(message, { [field.type === "formula" ? "expression" : "targetFieldId"]: message }, { cycle });
  }
  return field;
}

function saveFields(table: Table, fields: Field[]): void {
  getDb().prepare("UPDATE tables SET fields = ?, version = version + 1 WHERE id = ?").run(JSON.stringify(fields), table.id);
}

/** Tells open grids: this table's fields changed; other tables only had values recomputed. */
function announceSchemaChange(tableId: string, recomputed: string[], origin: Origin, deletedFieldId?: string) {
  getDb().transaction(() => {
    appendEvent(tableId, { kind: "schema", origin, ...(deletedFieldId ? { deletedFieldId } : {}) });
    for (const other of recomputed) if (other !== tableId) appendEvent(other, { kind: "reload", origin });
  })();
}

export function createField(tableId: string, input: Record<string, unknown>, origin: Origin = SYSTEM_ORIGIN): Field {
  const table = requireTable(tableId);
  const id = typeof input.id === "string" ? input.id : newId("fld");
  // Field ids are unique across the base, not just the table: the dependency graph, formulas
  // and batch writes look fields up by id in all tables at once.
  if (getBaseSchema(table.baseId).some((other) => other.fields.some((existing) => existing.id === id))) {
    throw new ApiError("CONFLICT", 409, "A field with this id already exists");
  }
  const field = prepareField(table, { ...input, id });
  saveFields(table, [...table.fields, field]);
  // Views show fields missing from `fieldOrder` at the end, so views don't need updating.
  announceSchemaChange(table.id, isComputedField(field) ? recomputeAllRows(table.baseId, [field.id]) : [], origin);
  return field;
}

/**
 * Settings whose change would leave existing values in the wrong shape: links pointing into
 * another table, several links in a single-link field, date-only values in a date-time field.
 */
function unconvertibleChange(existing: Field, input: Record<string, unknown>): { key: string; message: string } | null {
  if (existing.type === "link") {
    if (input.targetTableId !== undefined && input.targetTableId !== existing.targetTableId) {
      return { key: "targetTableId", message: "Changing the linked table" };
    }
    if (existing.multiple && input.multiple === false) return { key: "multiple", message: "Limiting a link to one record" };
  }
  if (existing.type === "date" && input.includeTime !== undefined && input.includeTime !== existing.includeTime) {
    return { key: "includeTime", message: "Switching between date and date with time" };
  }
  return null;
}

/** Core supports renaming and editing settings; changing the type (with conversion) is Advanced. */
export function updateField(tableId: string, fieldId: string, input: Record<string, unknown>, origin: Origin = SYSTEM_ORIGIN): Field {
  const table = requireTable(tableId);
  const existing = table.fields.find((field) => field.id === fieldId);
  if (!existing) throw notFound("Field");
  if (input.type !== undefined && input.type !== existing.type) {
    throw validationError("Changing the field type isn't supported yet", { type: "Changing the type isn't supported yet" });
  }
  // These settings change what stored values mean, so like a type change they'd need a conversion.
  const unconvertible = unconvertibleChange(existing, input);
  if (unconvertible) throw validationError(`${unconvertible.message} isn't supported yet`, { [unconvertible.key]: `${unconvertible.message} isn't supported yet` });

  // Unspecified properties keep their current value, so a rename can send just `{ name }`.
  const current = existing.type === "formula" ? { ...existing, expression: toDisplayExpression(existing.expression, table.fields) } : existing;
  const field = prepareField(table, { ...current, ...input, id: fieldId, type: existing.type }, existing);

  if ((field.type === "singleSelect" || field.type === "multiSelect") && "options" in existing) {
    const kept = new Set(field.options.map((option) => option.id));
    if (existing.options.some((option) => !kept.has(option.id))) {
      // Removing an option would need clearing its values in every row: not supported in Core.
      throw validationError("Options can't be removed yet", { options: "Options can't be removed yet" });
    }
  }

  saveFields(table, table.fields.map((candidate) => (candidate.id === fieldId ? field : candidate)));
  const definitionChanged =
    isComputedField(field) && JSON.stringify({ ...field, name: "" }) !== JSON.stringify({ ...existing, name: "" });
  announceSchemaChange(table.id, definitionChanged ? recomputeAllRows(table.baseId, [field.id]) : [], origin);
  return field;
}

export type FieldDependent = { id: string; name: string; tableId: string };

/** Formulas and lookups (in any table) that read this field directly. They break if it's deleted. */
export function fieldDependents(baseId: string, fieldId: string): FieldDependent[] {
  return getBaseSchema(baseId).flatMap((table) =>
    table.fields
      .filter((field) => field.id !== fieldId && fieldDependencies(field).includes(fieldId))
      .map((field) => ({ id: field.id, name: field.name, tableId: table.tableId })),
  );
}

/** Removes every reference to a field from a view's settings. */
function viewWithoutField(view: View, fieldId: string): View {
  const keep = (id: string) => id !== fieldId;
  const columnWidths = { ...view.columnWidths };
  delete columnWidths[fieldId];
  return {
    ...view,
    fieldOrder: view.fieldOrder.filter(keep),
    hiddenFieldIds: view.hiddenFieldIds.filter(keep),
    columnWidths,
    sorts: view.sorts.filter((sort) => keep(sort.fieldId)),
    groupBy: view.groupBy?.filter((group) => keep(group.fieldId)),
    filter: {
      ...view.filter,
      conditions: view.filter.conditions.filter((condition) => keep(condition.fieldId)),
      groups: view.filter.groups.map((group) => ({ ...group, conditions: group.conditions.filter((condition) => keep(condition.fieldId)) })),
    },
  };
}

/**
 * Deletes a field. Without `force`, a field that formulas or lookups read is not
 * deleted: the caller gets 409 with the list, to confirm. After deletion those
 * formulas evaluate to `#REF!` instead of failing.
 */
export function deleteField(tableId: string, fieldId: string, force: boolean, origin: Origin = SYSTEM_ORIGIN): void {
  const table = requireTable(tableId);
  if (!table.fields.some((field) => field.id === fieldId)) throw notFound("Field");
  if (table.primaryFieldId === fieldId) {
    throw new ApiError("VALIDATION_ERROR", 400, "The primary field can't be deleted");
  }

  const dependents = fieldDependents(table.baseId, fieldId);
  if (dependents.length > 0 && !force) {
    throw new ApiError("CONFLICT", 409, `${dependents.length} field(s) depend on this field`, { details: { dependents } });
  }

  const db = getDb();
  db.transaction(() => {
    saveFields(table, table.fields.filter((field) => field.id !== fieldId));
    const updateView = db.prepare("UPDATE views SET config = ?, version = version + 1 WHERE id = ?");
    for (const view of table.views) updateView.run(JSON.stringify(viewWithoutField(view, fieldId)), view.id);
    db.prepare("UPDATE rows SET cells = json_remove(cells, ?) WHERE table_id = ?").run(`$."${fieldId}"`, tableId);
  })();
  announceSchemaChange(table.id, recomputeAllRows(table.baseId, [fieldId]), origin, fieldId);
}

export type FormulaCheck =
  | { ok: true; resultType: FormulaResultType; dependencies: { id: string; name: string }[] }
  | { ok: false; error: { message: string; position: number } };

/**
 * Checks a formula as typed (with names) without saving it: type, dependencies,
 * or an error with its position. With `fieldId`, also detects a cycle that saving
 * this expression into that field would create.
 */
export function checkFormula(tableId: string, expression: string, fieldId?: string): FormulaCheck {
  const table = requireTable(tableId);
  try {
    const compiled = compileFormula(expression, fieldByNameResolver(table.fields));
    const names = new Map(table.fields.map((field) => [field.id, field.name]));
    const existing = fieldId ? table.fields.find((field) => field.id === fieldId) : undefined;
    if (existing) {
      const candidate: Field = { id: existing.id, name: existing.name, type: "formula", expression: toStoredExpression(expression, table.fields), resultType: compiled.resultType };
      const cycle = cyclePath(table.baseId, candidate);
      if (cycle) return { ok: false, error: { message: `Circular reference: ${cycle.join(" → ")}`, position: 0 } };
    }
    return {
      ok: true,
      resultType: compiled.resultType,
      dependencies: compiled.fieldIds.map((id) => ({ id, name: names.get(id) ?? id })),
    };
  } catch (error) {
    if (error instanceof FormulaSyntaxError) return { ok: false, error: { message: error.message, position: error.position } };
    throw error;
  }
}
