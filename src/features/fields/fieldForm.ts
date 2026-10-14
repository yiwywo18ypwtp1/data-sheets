import type { CellValue } from "@/lib/domain/cell";
import { fieldSchema, type Field, type FieldType } from "@/lib/domain/field";
import type { Row } from "@/lib/domain/row";
import { compileFormula } from "@/lib/formula/compile";
import { evaluate, type EvalContext } from "@/lib/formula/evaluate";
import { FormulaSyntaxError } from "@/lib/formula/lexer";
import { fieldByNameResolver, toDisplayExpression } from "@/lib/formula/references";
import { fromCellValue, isFormulaError, toCellValue } from "@/lib/formula/values";

export const FIELD_TYPE_LABELS: Record<FieldType, string> = {
  text: "Text",
  number: "Number",
  currency: "Currency",
  date: "Date",
  checkbox: "Checkbox",
  singleSelect: "Single select",
  multiSelect: "Multiple select",
  email: "Email",
  url: "URL",
  link: "Link to another table",
  lookup: "Lookup",
  formula: "Formula",
};

export const OPTION_COLORS = ["#2563eb", "#16a34a", "#d97706", "#dc2626", "#7c3aed", "#0891b2", "#db2777", "#4b5563"];

/**
 * A fresh field of `type`, keeping its id and name. The form is reset to this when
 * the type changes, so settings of the previous type can't linger (discriminated union).
 */
export function fieldDefaults(type: FieldType, base: { id: string; name: string }, context: { tableIds: string[]; linkFieldIds: string[] }): Field {
  switch (type) {
    case "number":
      return { ...base, type, precision: 0 };
    case "currency":
      return { ...base, type, currency: "USD" };
    case "date":
      return { ...base, type, includeTime: false };
    case "singleSelect":
    case "multiSelect":
      return { ...base, type, options: [] };
    case "link":
      return { ...base, type, targetTableId: context.tableIds[0] ?? "", multiple: false };
    case "lookup":
      return { ...base, type, linkFieldId: context.linkFieldIds[0] ?? "", targetFieldId: "" };
    case "formula":
      return { ...base, type, expression: "", resultType: "text" };
    default:
      return { ...base, type } as Field;
  }
}

/** The shared field schema, plus the rule that needs the table: names are unique (case-insensitively). */
export function fieldFormSchema(otherFields: Field[]) {
  const names = new Set(otherFields.map((field) => field.name.trim().toLowerCase()));
  return fieldSchema.superRefine((field, ctx) => {
    if (names.has(field.name.trim().toLowerCase())) {
      ctx.addIssue({ code: "custom", path: ["name"], message: "A field with this name already exists" });
    }
  });
}

/** What the form edits: formulas as the user reads them, with names instead of ids. */
export function toFormValues(field: Field, tableFields: Field[]): Field {
  return field.type === "formula" ? { ...field, expression: toDisplayExpression(field.expression, tableFields) } : field;
}

export type PreviewResult = { rowId: string; value: CellValue } | { rowId: string; error: string };

/**
 * The formula (typed with names) evaluated on a few loaded rows, entirely on the
 * client: the same engine the server runs, so the preview is what will be stored.
 * Throws `FormulaSyntaxError` for an invalid formula (the editor shows it with its position).
 */
export function previewFormula(expression: string, fields: Field[], rows: Row[], context: EvalContext): PreviewResult[] {
  const compiled = compileFormula(expression, fieldByNameResolver(fields));
  const byId = new Map(fields.map((field) => [field.id, field]));
  return rows.map((row) => {
    const result = evaluate(compiled, (id) => fromCellValue(byId.get(id)!, row.values[id]), context);
    return isFormulaError(result) ? { rowId: row.id, error: `${result.code} ${result.message}` } : { rowId: row.id, value: toCellValue(result) };
  });
}

export { FormulaSyntaxError };
