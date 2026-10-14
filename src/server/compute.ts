import "server-only";
import type { CellValue } from "@/lib/domain/cell";
import type { Field } from "@/lib/domain/field";
import { compileStoredFormula, type CompiledFormula } from "@/lib/formula/compile";
import { brokenFormulaError, evaluate, type EvalContext } from "@/lib/formula/evaluate";
import {
  formulaError,
  fromCellValue,
  isFormulaError,
  toCellValue,
  toText,
  type FormulaError,
  type FormulaValue,
} from "@/lib/formula/values";

/** Reads `fieldId` of the given rows of another table; used to fill lookups. */
export type LinkedValuesReader = (tableId: string, rowIds: string[], fieldId: string) => CellValue[];

export type FieldIndex = ReadonlyMap<string, Field>;

/**
 * Compiled formulas are cached per formula field for one batch or seed run:
 * evaluating 50 000 rows must not re-parse the same expression 50 000 times.
 */
export class FormulaCache {
  private readonly compiled = new Map<string, CompiledFormula | FormulaError>();

  constructor(private readonly fields: FieldIndex) {}

  get(field: Extract<Field, { type: "formula" }>): CompiledFormula | FormulaError {
    let formula = this.compiled.get(field.id);
    if (!formula) {
      try {
        formula = compileStoredFormula(field.expression, this.fields);
      } catch (error) {
        formula = brokenFormulaError(error);
      }
      this.compiled.set(field.id, formula);
    }
    return formula;
  }
}

/**
 * Lookup values are stored as the target values' text (`["12.5"]`), so they
 * filter as text and read in formulas the same way they're displayed.
 */
function lookupValue(field: Extract<Field, { type: "lookup" }>, values: Record<string, CellValue>, fields: FieldIndex, readLinked: LinkedValuesReader): CellValue {
  const link = fields.get(field.linkFieldId);
  const target = fields.get(field.targetFieldId);
  const linkedIds = values[field.linkFieldId];
  if (link?.type !== "link" || !target || !Array.isArray(linkedIds) || linkedIds.length === 0) return null;

  const texts = readLinked(link.targetTableId, linkedIds, target.id)
    .map((value) => fromCellValue(target, value))
    .map((value) => (isFormulaError(value) ? "" : toText(value)))
    .filter((text) => text !== "");
  return texts.length > 0 ? texts : null;
}

export type ComputedResult = { values: Record<string, CellValue>; errors: Record<string, string> };

/**
 * Computes `fieldIdsInOrder` (lookups and formulas, already in dependency order)
 * for one row. Each result is visible to the fields after it. Formula errors go to
 * `errors` and leave the value empty.
 */
export function computeFields(
  fieldIdsInOrder: readonly string[],
  row: ComputedResult,
  fields: FieldIndex,
  formulas: FormulaCache,
  readLinked: LinkedValuesReader,
  context: EvalContext,
): ComputedResult {
  const values = { ...row.values };
  const errors = { ...row.errors };
  // Formula results keep their runtime type (dates, errors) for formulas that read them.
  const results = new Map<string, FormulaValue>();
  const getValue = (id: string): FormulaValue => {
    if (results.has(id)) return results.get(id)!;
    const field = fields.get(id);
    return field ? fromCellValue(field, values[id]) : formulaError("#REF!", "Field was deleted");
  };

  for (const id of fieldIdsInOrder) {
    const field = fields.get(id);
    if (field?.type === "lookup") {
      values[id] = lookupValue(field, values, fields, readLinked);
    } else if (field?.type === "formula") {
      const formula = formulas.get(field);
      const result = "ast" in formula ? evaluate(formula, getValue, context) : formula;
      results.set(id, result);
      delete errors[id];
      if (isFormulaError(result)) {
        values[id] = null;
        errors[id] = `${result.code} ${result.message}`;
      } else {
        values[id] = toCellValue(result);
      }
    }
  }
  return { values, errors };
}
