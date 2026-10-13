import { z } from "zod";
import type { Field } from "./field";
import { filterFieldIssues, filterGroupSchema } from "./filter";
import { idSchema } from "./ids";

function hasNoDuplicates(ids: string[]): boolean {
  return new Set(ids).size === ids.length;
}

export const sortSchema = z.object({ fieldId: idSchema, direction: z.enum(["asc", "desc"]) });
export type Sort = z.infer<typeof sortSchema>;

export const sortsSchema = z
  .array(sortSchema)
  .max(10)
  .refine((sorts) => hasNoDuplicates(sorts.map((sort) => sort.fieldId)), "A field can be sorted only once");

export const rowHeightSchema = z.enum(["short", "medium", "tall"]);
export type RowHeight = z.infer<typeof rowHeightSchema>;

export const MIN_COLUMN_WIDTH = 60;
export const MAX_COLUMN_WIDTH = 800;

export const viewSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1, "Name is required").max(100),
  kind: z.enum(["grid", "form"]),
  filter: filterGroupSchema,
  sorts: sortsSchema,
  groupBy: z.array(z.object({ fieldId: idSchema })).max(2).optional(),
  hiddenFieldIds: z.array(idSchema).refine(hasNoDuplicates, "Duplicate field"),
  fieldOrder: z.array(idSchema).refine(hasNoDuplicates, "Duplicate field"),
  columnWidths: z.record(idSchema, z.number().int().min(MIN_COLUMN_WIDTH).max(MAX_COLUMN_WIDTH)),
  rowHeight: rowHeightSchema,
});
export type View = z.infer<typeof viewSchema>;

/** The part of a view edited in the view panel (one RHF form). */
export const viewConfigSchema = viewSchema.pick({ filter: true, sorts: true, hiddenFieldIds: true });
export type ViewConfig = z.infer<typeof viewConfigSchema>;

/** Array-valued fields have no natural order, so they can't be sorted. */
export function isSortable(field: Field): boolean {
  return field.type !== "link" && field.type !== "multiSelect" && field.type !== "lookup";
}

/**
 * The view config schema checked against the table's current fields.
 * The same schema is used by the view panel (zodResolver) and by the server when saving,
 * so both sides reject the same things with the same messages.
 */
export function viewConfigSchemaFor(fields: Field[]) {
  const fieldsById = new Map(fields.map((field) => [field.id, field]));

  return viewConfigSchema.superRefine((config, ctx) => {
    for (const issue of filterFieldIssues(config.filter, fields)) {
      ctx.addIssue({ code: "custom", path: ["filter", ...issue.path], message: issue.message });
    }
    config.sorts.forEach((sort, i) => {
      const field = fieldsById.get(sort.fieldId);
      if (!field) {
        ctx.addIssue({ code: "custom", path: ["sorts", i, "fieldId"], message: "Field no longer exists" });
      } else if (!isSortable(field)) {
        ctx.addIssue({ code: "custom", path: ["sorts", i, "fieldId"], message: "This field can't be sorted" });
      }
    });
    config.hiddenFieldIds.forEach((id, i) => {
      if (!fieldsById.has(id)) {
        ctx.addIssue({ code: "custom", path: ["hiddenFieldIds", i], message: "Field no longer exists" });
      }
    });
  });
}
