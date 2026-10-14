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
import { recomputeAllRows } from "./rowWrites";
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
function prepareField(table: Table, input: Record<string, unknown>): Field {
  const candidate: Record<string, unknown> = { ...input };

  if (candidate.type === "formula" && typeof candidate.expression === "string") {
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
  const tableCheck = tableMetaSchema.safeParse({ ...table, fields });
  if (!tableCheck.success) {
    const index = fields.indexOf(field);
    const own = tableCheck.error.issues.filter((issue) => issue.path[0] === "fields" && issue.path[1] === index);
    const fieldErrors = zodFieldErrors(own.map((issue) => ({ ...issue, path: issue.path.slice(2) })));
    throw validationError(own[0]?.message ?? tableCheck.error.issues[0].message, fieldErrors);
  }

  const baseTables = getBaseSchema(table.baseId);
  if (field.type === "link" && !baseTables.some((candidateTable) => candidateTable.tableId === field.targetTableId)) {
    throw validationError("Linked table does not exist", { targetTableId: "Linked table does not exist" });
  }
  if (field.type === "lookup") {
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

export function createField(tableId: string, input: Record<string, unknown>): Field {
  const table = requireTable(tableId);
  const field = prepareField(table, { ...input, id: typeof input.id === "string" ? input.id : newId("fld") });
  if (table.fields.some((existing) => existing.id === field.id)) {
    throw new ApiError("CONFLICT", 409, "A field with this id already exists");
  }
  saveFields(table, [...table.fields, field]);
  // Views show fields missing from `fieldOrder` at the end, so views don't need updating.
  if (isComputedField(field)) recomputeAllRows(table.baseId, [field.id]);
  return field;
}

/** Core supports renaming and editing settings; changing the type (with conversion) is Advanced. */
export function updateField(tableId: string, fieldId: string, input: Record<string, unknown>): Field {
  const table = requireTable(tableId);
  const existing = table.fields.find((field) => field.id === fieldId);
  if (!existing) throw notFound("Field");
  if (input.type !== undefined && input.type !== existing.type) {
    throw validationError("Changing the field type isn't supported yet", { type: "Changing the type isn't supported yet" });
  }

  // Unspecified properties keep their current value, so a rename can send just `{ name }`.
  const current = existing.type === "formula" ? { ...existing, expression: toDisplayExpression(existing.expression, table.fields) } : existing;
  const field = prepareField(table, { ...current, ...input, id: fieldId, type: existing.type });

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
  if (definitionChanged) recomputeAllRows(table.baseId, [field.id]);
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
export function deleteField(tableId: string, fieldId: string, force: boolean): void {
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
  recomputeAllRows(table.baseId, [fieldId]);
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
