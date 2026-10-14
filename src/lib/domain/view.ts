import { z } from "zod";
import type { Field } from "./field";
import { filterFieldIssues, filterGroupSchema } from "./filter";
import { formConfigSchema } from "./form";
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
  groupBy: z
    .array(z.object({ fieldId: idSchema }))
    .max(2, "Group by at most two fields")
    .refine((groups) => hasNoDuplicates(groups.map((group) => group.fieldId)), "A field can be grouped by only once")
    .optional(),
  hiddenFieldIds: z.array(idSchema).refine(hasNoDuplicates, "Duplicate field"),
  fieldOrder: z.array(idSchema).refine(hasNoDuplicates, "Duplicate field"),
  columnWidths: z.record(idSchema, z.number().int().min(MIN_COLUMN_WIDTH).max(MAX_COLUMN_WIDTH)),
  rowHeight: rowHeightSchema,
  /** Only for `kind: "form"`: the public form's questions (see form.ts). */
  form: formConfigSchema.optional(),
});
export type View = z.infer<typeof viewSchema>;

/** The part of a view edited in the view panel (one RHF form): what rows are shown, and in what order. */
export const viewQuerySchema = viewSchema.pick({ filter: true, sorts: true, groupBy: true });
export type ViewQuery = z.infer<typeof viewQuerySchema>;

/** Everything in a view that refers to fields, checked against the table on save. */
export const viewConfigSchema = viewSchema.pick({ filter: true, sorts: true, groupBy: true, hiddenFieldIds: true });
export type ViewConfig = z.infer<typeof viewConfigSchema>;

/** Array-valued fields have no natural order, so they can't be sorted. */
export function isSortable(field: Field): boolean {
  return field.type !== "link" && field.type !== "multiSelect" && field.type !== "lookup";
}

type IssueContext = { addIssue: (issue: { code: "custom"; path: (string | number)[]; message: string }) => void };

function addQueryIssues(query: ViewQuery, fields: Field[], ctx: IssueContext) {
  const fieldsById = new Map(fields.map((field) => [field.id, field]));
  for (const issue of filterFieldIssues(query.filter, fields)) {
    ctx.addIssue({ code: "custom", path: ["filter", ...issue.path], message: issue.message });
  }
  query.groupBy?.forEach((group, i) => {
    const field = fieldsById.get(group.fieldId);
    if (!field) {
      ctx.addIssue({ code: "custom", path: ["groupBy", i, "fieldId"], message: "Field no longer exists" });
    } else if (!isSortable(field)) {
      ctx.addIssue({ code: "custom", path: ["groupBy", i, "fieldId"], message: "This field can't be grouped by" });
    }
  });
  query.sorts.forEach((sort, i) => {
    const field = fieldsById.get(sort.fieldId);
    if (!field) {
      ctx.addIssue({ code: "custom", path: ["sorts", i, "fieldId"], message: "Field no longer exists" });
    } else if (!isSortable(field)) {
      ctx.addIssue({ code: "custom", path: ["sorts", i, "fieldId"], message: "This field can't be sorted" });
    }
  });
}

/**
 * The view panel's schema checked against the table's current fields. The panel
 * (zodResolver) and the server (on save) use the same rules, so both sides reject
 * the same things with the same messages.
 */
export function viewQuerySchemaFor(fields: Field[]) {
  return viewQuerySchema.superRefine((query, ctx) => addQueryIssues(query, fields, ctx));
}

/** `viewQuerySchemaFor` plus hidden fields: what the server checks when a view is saved. */
export function viewConfigSchemaFor(fields: Field[]) {
  const fieldIds = new Set(fields.map((field) => field.id));
  return viewConfigSchema.superRefine((config, ctx) => {
    addQueryIssues(config, fields, ctx);
    config.hiddenFieldIds.forEach((id, i) => {
      if (!fieldIds.has(id)) ctx.addIssue({ code: "custom", path: ["hiddenFieldIds", i], message: "Field no longer exists" });
    });
  });
}
