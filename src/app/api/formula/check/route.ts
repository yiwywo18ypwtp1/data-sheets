import { z } from "zod";
import { idSchema } from "@/lib/domain/ids";
import { MAX_FORMULA_LENGTH } from "@/lib/domain/field";
import { apiRoute, parseJsonBody } from "@/server/api";
import { getCurrentUser } from "@/server/auth";
import { checkFormula } from "@/server/fields";

const bodySchema = z.object({
  tableId: idSchema,
  expression: z.string().max(MAX_FORMULA_LENGTH, "Formula is too long"),
  /** When editing an existing formula field: also checks for cycles through it. */
  fieldId: idSchema.optional(),
});

/** Result type, dependencies, or an error with its position. Always 200: an invalid formula is a valid answer. */
export const POST = apiRoute(async (request) => {
  await getCurrentUser();
  const { tableId, expression, fieldId } = await parseJsonBody(request, bodySchema);
  return Response.json(checkFormula(tableId, expression, fieldId));
});
