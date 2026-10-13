import { z } from "zod";
import { fieldSchema } from "./field";
import { idSchema } from "./ids";
import { viewSchema } from "./view";

/**
 * Only rules that need the table's own fields are checked here.
 * Cross-table rules (link target exists, lookup target field exists, formula
 * references and cycles) need other tables and are checked on the server.
 */
export const tableMetaSchema = z
  .object({
    id: idSchema,
    name: z.string().trim().min(1).max(100),
    primaryFieldId: idSchema,
    fields: z.array(fieldSchema).min(1).max(500),
    views: z.array(viewSchema).min(1),
    version: z.number().int().nonnegative(),
  })
  .superRefine((table, ctx) => {
    const ids = new Set<string>();
    const names = new Set<string>();
    table.fields.forEach((field, i) => {
      if (ids.has(field.id)) ctx.addIssue({ code: "custom", path: ["fields", i, "id"], message: "Duplicate field id" });
      // Names must be unique case-insensitively because formulas reference fields by name.
      const name = field.name.toLowerCase();
      if (names.has(name)) {
        ctx.addIssue({ code: "custom", path: ["fields", i, "name"], message: "A field with this name already exists" });
      }
      ids.add(field.id);
      names.add(name);
    });

    if (!ids.has(table.primaryFieldId)) {
      ctx.addIssue({ code: "custom", path: ["primaryFieldId"], message: "Primary field does not exist" });
    }

    table.fields.forEach((field, i) => {
      if (field.type !== "lookup") return;
      const link = table.fields.find((candidate) => candidate.id === field.linkFieldId);
      if (link?.type !== "link") {
        ctx.addIssue({ code: "custom", path: ["fields", i, "linkFieldId"], message: "Lookup must use a link field" });
      }
    });
  });
export type TableMeta = z.infer<typeof tableMetaSchema>;

export const baseSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(100),
  tables: z.array(tableMetaSchema),
});
export type Base = z.infer<typeof baseSchema>;
