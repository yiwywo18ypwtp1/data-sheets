import { z } from "zod";
import { createCoercer, type CoerceOptions } from "@/lib/coerce/coerce";
import type { CellValue } from "@/lib/domain/cell";
import { fieldNameSchema, isComputedField, type Field } from "@/lib/domain/field";

/**
 * CSV import, step 2 and 3: what each CSV column goes into, and the runtime zod schema
 * that turns a CSV row (texts) into cell values for those fields.
 */

/** Types a new field can be created with from a CSV column. */
export const NEW_FIELD_TYPES = ["text", "number", "date", "dateTime", "checkbox", "singleSelect", "email", "url"] as const;
export type NewFieldType = (typeof NEW_FIELD_TYPES)[number];

export const NEW_FIELD_TYPE_LABELS: Record<NewFieldType, string> = {
  text: "Text",
  number: "Number",
  date: "Date",
  dateTime: "Date and time",
  checkbox: "Checkbox",
  singleSelect: "Single select",
  email: "Email",
  url: "URL",
};

/** Select options are made from the column's distinct values, up to the field schema's limit. */
export const MAX_OPTIONS = 200;
const OPTION_COLORS = ["#2563eb", "#16a34a", "#d97706", "#dc2626", "#7c3aed", "#0891b2", "#db2777", "#4b5563"];

/**
 * One CSV column's mapping. A discriminated union, so "existing" can't carry a stale
 * new-field type and the other way round. `newFieldId` is generated up front, so the
 * created field keeps a known id even if creating it has to be retried.
 */
export const columnMappingSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("skip") }),
  z.object({ action: z.literal("existing"), fieldId: z.string().min(1, "Pick a field") }),
  z.object({ action: z.literal("new"), newFieldId: z.string().min(1), name: fieldNameSchema, type: z.enum(NEW_FIELD_TYPES) }),
]);
export type ColumnMapping = z.infer<typeof columnMappingSchema>;
export type MappingForm = { columns: ColumnMapping[] };

/** Fields a CSV column can be imported into. Links need matching by primary value (not in Core). */
export function isImportable(field: Field): boolean {
  return !isComputedField(field) && field.type !== "link";
}

/**
 * The mapping form's schema for a table: every rule that needs to see all columns at
 * once (one field per column, unique new names, something to import) lives here.
 */
export function mappingSchemaFor(fields: Field[]) {
  const byId = new Map(fields.map((field) => [field.id, field]));
  const existingNames = new Set(fields.map((field) => field.name.trim().toLowerCase()));

  return z.object({ columns: z.array(columnMappingSchema) }).superRefine(({ columns }, ctx) => {
    const usedBy = new Map<string, number>();
    const newNames = new Map<string, number>();
    columns.forEach((column, index) => {
      if (column.action === "existing") {
        const field = byId.get(column.fieldId);
        if (!field || !isImportable(field)) {
          ctx.addIssue({ code: "custom", path: ["columns", index, "fieldId"], message: "This field can't be imported into" });
        } else if (usedBy.has(column.fieldId)) {
          const message = `Column ${usedBy.get(column.fieldId)! + 1} already goes into “${field.name}”`;
          ctx.addIssue({ code: "custom", path: ["columns", index, "fieldId"], message });
        } else {
          usedBy.set(column.fieldId, index);
        }
      }
      if (column.action === "new") {
        const name = column.name.trim().toLowerCase();
        if (existingNames.has(name)) {
          ctx.addIssue({ code: "custom", path: ["columns", index, "name"], message: "A field with this name already exists; map the column to it instead" });
        } else if (newNames.has(name)) {
          ctx.addIssue({ code: "custom", path: ["columns", index, "name"], message: `Column ${newNames.get(name)! + 1} creates a field with this name too` });
        } else {
          newNames.set(name, index);
        }
      }
    });
    if (columns.every((column) => column.action === "skip")) {
      ctx.addIssue({ code: "custom", path: ["columns"], message: "Choose at least one column to import" });
    }
  });
}

const normalize = (text: string) => text.trim().toLowerCase().replace(/[\s_-]+/g, " ");

/**
 * The initial mapping: a column whose header matches an importable field's name goes
 * into it (each field once); any other column becomes a new field of the inferred type.
 */
export function autoMap(headers: string[], fields: Field[], sampleColumn: (index: number) => string[], options: CoerceOptions, newId: () => string): ColumnMapping[] {
  const available = new Map(fields.filter(isImportable).map((field) => [normalize(field.name), field]));
  const takenNames = new Set(fields.map((field) => normalize(field.name)));
  return headers.map((header, index) => {
    const match = available.get(normalize(header));
    if (match) {
      available.delete(normalize(header));
      return { action: "existing", fieldId: match.id };
    }
    let name = header.trim().replace(/[{}]/g, "") || `Column ${index + 1}`;
    while (takenNames.has(normalize(name))) name = `${name} (import)`;
    takenNames.add(normalize(name));
    return { action: "new", newFieldId: newId(), name: name.slice(0, 100), type: inferType(sampleColumn(index), options) };
  });
}

/** Share of sample values that must convert for a type to be suggested. */
const INFER_SHARE = 0.9;

/**
 * The narrowest type (nearly) every non-empty sample value converts to. Checkbox is tried first
 * (a column of only "1"/"0" stays a number), dates before numbers ("2026" alone stays
 * a number because it isn't a full date).
 */
export function inferType(samples: string[], options: CoerceOptions): NewFieldType {
  const values = samples.map((value) => value.trim()).filter((value) => value !== "");
  if (values.length === 0) return "text";
  // "Most" values, not all: a column of dates with one typo is still a date column, and the
  // typo shows up in step 3 as an error to fix instead of turning the column into text.
  const all = (field: Field) => {
    const coerce = createCoercer(field, options);
    return values.filter((value) => coerce(value).ok).length >= Math.max(1, values.length * INFER_SHARE);
  };
  const id = "fld_infer";
  if (values.some((value) => !/^[01]$/.test(value)) && all({ id, name: "x", type: "checkbox" })) return "checkbox";
  // A date-only field also accepts "12.03.2026 14:30" (it keeps the date), so times are checked first.
  if (values.some((value) => /\d:\d/.test(value)) && all({ id, name: "x", type: "date", includeTime: true })) return "dateTime";
  if (all({ id, name: "x", type: "date", includeTime: false })) return "date";
  if (all({ id, name: "x", type: "number", precision: 4 })) return "number";
  const most = (pattern: RegExp) => values.filter((value) => pattern.test(value)).length >= values.length * INFER_SHARE;
  if (most(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) return "email";
  if (most(/^https?:\/\/\S+$/i)) return "url";
  return "text";
}

/** Decimal places a number column needs: the most any of its values has, at most 4. */
function precisionOf(values: string[], options: CoerceOptions): 0 | 1 | 2 | 3 | 4 {
  const coerce = createCoercer({ id: "fld_precision", name: "x", type: "number", precision: 4 }, options);
  let digits = 0;
  for (const value of values) {
    const result = coerce(value);
    if (result.ok && typeof result.value === "number") digits = Math.max(digits, String(result.value).split(".")[1]?.length ?? 0);
  }
  return Math.min(4, digits) as 0 | 1 | 2 | 3 | 4;
}

/**
 * The field a "new" column will create. Select options are the column's distinct
 * values; a number's precision is the most decimals seen. Throws a readable error
 * when a select would need more options than a field can have.
 */
export function draftField(column: Extract<ColumnMapping, { action: "new" }>, values: string[], options: CoerceOptions): Field {
  const base = { id: column.newFieldId, name: column.name.trim() };
  switch (column.type) {
    case "number":
      return { ...base, type: "number", precision: precisionOf(values, options) };
    case "date":
      return { ...base, type: "date", includeTime: false };
    case "dateTime":
      return { ...base, type: "date", includeTime: true };
    case "singleSelect": {
      const labels = new Map<string, string>();
      for (const value of values) {
        const label = value.trim().slice(0, 100);
        if (label !== "" && !labels.has(label.toLowerCase())) labels.set(label.toLowerCase(), label);
      }
      if (labels.size > MAX_OPTIONS) throw new Error(`“${column.name}” has ${labels.size} different values; a select can have at most ${MAX_OPTIONS}`);
      return {
        ...base,
        type: "singleSelect",
        options: [...labels.values()].map((label, i) => ({ id: `${column.newFieldId}_o${i}`, label, color: OPTION_COLORS[i % OPTION_COLORS.length] })),
      };
    }
    default:
      return { ...base, type: column.type };
  }
}

/** A CSV column and the field its values go into. */
export type ImportTarget = { column: number; header: string; field: Field };

/**
 * The runtime schema of step 3: one zod object for the whole row, built from the mapping
 * and the target fields' types. Each column is a string transformed by that field's coercer
 * (the same one paste and the cell editors use), so a value that can't be converted is a
 * zod issue on that field, with the coercer's message.
 */
export function buildRowSchema(targets: ImportTarget[], options: CoerceOptions) {
  const shape: Record<string, z.ZodType<CellValue, string>> = {};
  for (const target of targets) {
    const coerce = createCoercer(target.field, options);
    shape[target.field.id] = z.string().transform((text, ctx) => {
      const result = coerce(text);
      if (result.ok) return result.value;
      ctx.addIssue({ code: "custom", message: result.error });
      return z.NEVER;
    });
  }
  return z.object(shape);
}

/** A CSV row as the row schema's input: `{ fieldId: text }` for every mapped column. */
export function rowInput(targets: ImportTarget[], row: string[], override?: (column: number) => string | undefined): Record<string, string> {
  const input: Record<string, string> = {};
  for (const target of targets) input[target.field.id] = override?.(target.column) ?? row[target.column] ?? "";
  return input;
}

/**
 * The fields the mapped columns go into: existing ones as they are, new ones as drafts
 * built from the column's values. Throws (with a message for the user) when a draft
 * can't be built, e.g. a select with too many different values.
 */
export function importTargets(mapping: ColumnMapping[], headers: string[], fields: Field[], columnValues: (column: number) => string[], options: CoerceOptions): ImportTarget[] {
  const byId = new Map(fields.map((field) => [field.id, field]));
  return mapping.flatMap((column, index): ImportTarget[] => {
    if (column.action === "skip") return [];
    const field = column.action === "existing" ? byId.get(column.fieldId) : draftField(column, columnValues(index), options);
    return field ? [{ column: index, header: headers[index], field }] : [];
  });
}
