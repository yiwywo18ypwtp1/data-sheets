import { z } from "zod";
import type { Field, FieldOfType } from "./field";
import { idSchema } from "./ids";

/** For link and multiSelect fields the value is an array of ids. `null` means empty. */
export type CellValue = string | number | boolean | string[] | null;

export const cellValueSchema: z.ZodType<CellValue> = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
  z.null(),
]);

/**
 * Storage formats (locale-neutral):
 * - date without time: `YYYY-MM-DD`
 * - date with time: UTC instant `YYYY-MM-DDTHH:mm:ss.sssZ`; the field's time zone only affects display and input
 * - currency: plain number in major units
 */
export const dateOnlySchema = z.iso.date();
export const utcInstantSchema = z.iso.datetime();

function hasAtMostDecimals(value: number, precision: number): boolean {
  return Number(value.toFixed(precision)) === value;
}

function numberValueSchema(field: FieldOfType<"number">) {
  let schema = z.number().refine((value) => hasAtMostDecimals(value, field.precision), {
    message: `At most ${field.precision} decimal places`,
  });
  if (field.min !== undefined) schema = schema.refine((value) => value >= field.min!, `Must be ≥ ${field.min}`);
  if (field.max !== undefined) schema = schema.refine((value) => value <= field.max!, `Must be ≤ ${field.max}`);
  return schema;
}

function uniqueIds(values: string[]): boolean {
  return new Set(values).size === values.length;
}

function writableValueSchema(field: Field): z.ZodType<CellValue> {
  switch (field.type) {
    case "text":
      return field.maxLength === undefined ? z.string() : z.string().max(field.maxLength);
    case "number":
      return numberValueSchema(field);
    case "currency":
      return z.number();
    case "date":
      return field.includeTime ? utcInstantSchema : dateOnlySchema;
    case "checkbox":
      return z.boolean();
    case "singleSelect": {
      const optionIds = field.options.map((option) => option.id);
      return z.string().refine((id) => optionIds.includes(id), "Unknown option");
    }
    case "multiSelect": {
      const optionIds = field.options.map((option) => option.id);
      return z
        .array(z.string())
        .refine((ids) => ids.every((id) => optionIds.includes(id)), "Unknown option")
        .refine(uniqueIds, "Duplicate option");
    }
    case "email":
      return z.email();
    case "url":
      // Only http(s): the value is rendered as a link, so `javascript:` URLs must never be stored.
      return z.url({ protocol: /^https?$/ });
    case "link": {
      // Existence of the linked rows is checked on the server, where the target table is available.
      const ids = z.array(idSchema).refine(uniqueIds, "Duplicate record");
      return field.multiple ? ids : ids.max(1, "Only one record can be linked");
    }
    case "lookup":
    case "formula":
      return z.never({ error: "Computed field cannot be edited" });
  }
}

/**
 * Schema for a value written into a cell of this field, shared by cell editors,
 * paste, CSV import and the batch endpoint. Build it once per field, not per cell.
 */
export function cellValueSchemaFor(field: Field): z.ZodType<CellValue> {
  if (field.type === "lookup" || field.type === "formula") return writableValueSchema(field);
  return writableValueSchema(field).nullable();
}
