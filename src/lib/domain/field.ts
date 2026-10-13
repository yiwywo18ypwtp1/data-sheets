import { z } from "zod";
import { idSchema } from "./ids";

/** Formulas reference fields as `{Name}`, so braces in a name would make references ambiguous. */
export const fieldNameSchema = z
  .string()
  .trim()
  .min(1, "Name is required")
  .max(100, "Name is too long")
  .refine((name) => !/[{}]/.test(name), "Name cannot contain { or }");

export const MAX_FORMULA_LENGTH = 10_000;

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

function isValidCurrency(code: string): boolean {
  return Intl.supportedValuesOf("currency").includes(code);
}

const base = { id: idSchema, name: fieldNameSchema };

export const selectOptionSchema = z.object({
  id: idSchema,
  label: z.string().trim().min(1, "Label is required").max(100),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Color must be #rrggbb"),
});
export type SelectOption = z.infer<typeof selectOptionSchema>;

const textField = z.object({
  ...base,
  type: z.literal("text"),
  maxLength: z.number().int().min(1).max(100_000).optional(),
});

const numberField = z.object({
  ...base,
  type: z.literal("number"),
  precision: z.literal([0, 1, 2, 3, 4]),
  min: z.number().optional(),
  max: z.number().optional(),
});

const currencyField = z.object({
  ...base,
  type: z.literal("currency"),
  currency: z.string().refine(isValidCurrency, "Unknown ISO 4217 currency code"),
});

const dateField = z.object({
  ...base,
  type: z.literal("date"),
  includeTime: z.boolean(),
  /** IANA time zone. When absent, values are shown in the viewer's own time zone. */
  timeZone: z.string().refine(isValidTimeZone, "Unknown time zone").optional(),
});

const checkboxField = z.object({ ...base, type: z.literal("checkbox") });

const selectOptions = z.array(selectOptionSchema).max(200);
const singleSelectField = z.object({ ...base, type: z.literal("singleSelect"), options: selectOptions });
const multiSelectField = z.object({ ...base, type: z.literal("multiSelect"), options: selectOptions });

const emailField = z.object({ ...base, type: z.literal("email") });
const urlField = z.object({ ...base, type: z.literal("url") });

const linkField = z.object({
  ...base,
  type: z.literal("link"),
  targetTableId: idSchema,
  multiple: z.boolean(),
});

const lookupField = z.object({
  ...base,
  type: z.literal("lookup"),
  linkFieldId: idSchema,
  targetFieldId: idSchema,
});

export const formulaResultTypeSchema = z.enum(["text", "number", "date", "checkbox"]);
export type FormulaResultType = z.infer<typeof formulaResultTypeSchema>;

const formulaField = z.object({
  ...base,
  type: z.literal("formula"),
  /** Stored with id references (`{fld_x}`); the UI converts them to and from names. */
  expression: z.string().min(1, "Formula is required").max(MAX_FORMULA_LENGTH, "Formula is too long"),
  resultType: formulaResultTypeSchema,
});

/**
 * Rules that span several properties live here instead of on the members,
 * because zod cannot `.extend()` or discriminate on refined object schemas.
 */
export const fieldSchema = z
  .discriminatedUnion("type", [
    textField,
    numberField,
    currencyField,
    dateField,
    checkboxField,
    singleSelectField,
    multiSelectField,
    emailField,
    urlField,
    linkField,
    lookupField,
    formulaField,
  ])
  .superRefine((field, ctx) => {
    if (field.type === "number" && field.min !== undefined && field.max !== undefined && field.min > field.max) {
      ctx.addIssue({ code: "custom", path: ["max"], message: "Max must be greater than or equal to min" });
    }
    if (field.type === "singleSelect" || field.type === "multiSelect") {
      // Labels must be unique: pasted or imported text is matched to an option by its label.
      const seen = new Set<string>();
      field.options.forEach((option, index) => {
        const key = option.label.trim().toLowerCase();
        if (seen.has(key)) {
          ctx.addIssue({ code: "custom", path: ["options", index, "label"], message: "Duplicate option label" });
        }
        seen.add(key);
      });
    }
  });

export type Field = z.infer<typeof fieldSchema>;
export type FieldType = Field["type"];
export type FieldOfType<T extends FieldType> = Extract<Field, { type: T }>;

/** Values of computed fields are derived on the server and cannot be written directly. */
export function isComputedField(field: Field): field is FieldOfType<"formula" | "lookup"> {
  return field.type === "formula" || field.type === "lookup";
}
