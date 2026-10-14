import type { CellValue } from "@/lib/domain/cell";
import type { Field } from "@/lib/domain/field";
import type { Row } from "@/lib/domain/row";
import { evaluateRowFormulas } from "@/lib/formula/evaluate";
import { buildDependencyGraph, dependentsOf, topologicalOrder, type DependencyGraph } from "@/lib/formula/graph";
import { isFormulaError, toCellValue } from "@/lib/formula/values";

/**
 * Optimistic rows: what the grid shows is the last row the server confirmed, with
 * the user's not-yet-confirmed edits applied on top and the row's formulas
 * recomputed. Nothing is overwritten in place, so undoing a failed edit is just
 * dropping it from the list: the other pending edits stay.
 */

/** One unconfirmed change to one row (one `update` op in a batch). */
export type PendingEdit = { opId: number; rowId: string; values: Record<string, CellValue> };

/** A row as displayed: may carry per-cell save errors and a "still saving" flag. */
export type DisplayRow = Row & { saveErrors?: Record<string, string>; saving?: boolean };

export type FormulaContext = { fieldsById: Map<string, Field>; graph: DependencyGraph };

export function buildFormulaContext(fields: Field[]): FormulaContext {
  return { fieldsById: new Map(fields.map((field) => [field.id, field])), graph: buildDependencyGraph(fields) };
}

export function displayRow(
  base: Row,
  edits: readonly PendingEdit[],
  saveErrors: Record<string, string> | undefined,
  context: FormulaContext,
  now: Date,
): DisplayRow {
  if (edits.length === 0) return saveErrors ? { ...base, saveErrors } : base;

  const values = { ...base.values };
  const errors = { ...base.errors };
  for (const edit of edits) Object.assign(values, edit.values);

  // Same-row formulas that read the edited cells, in dependency order. Lookups read
  // other tables, so they keep their stored value until the server's answer.
  const changed = new Set(edits.flatMap((edit) => Object.keys(edit.values)));
  const formulas = topologicalOrder(context.graph, dependentsOf(context.graph, changed)).filter(
    (id) => context.fieldsById.get(id)?.type === "formula",
  );
  for (const [id, result] of evaluateRowFormulas(formulas, values, context.fieldsById, { now })) {
    if (isFormulaError(result)) {
      values[id] = null;
      errors[id] = `${result.code} ${result.message}`;
    } else {
      values[id] = toCellValue(result);
      delete errors[id];
    }
  }

  return { ...base, values, errors, saving: true, ...(saveErrors ? { saveErrors } : {}) };
}
