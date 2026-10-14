import { z } from "zod";
import { apiRoute, parseJsonBody } from "@/server/api";
import { assertRole, getCurrentUser } from "@/server/auth";
import { ApiError } from "@/server/errors";
import { deleteField, updateField } from "@/server/fields";

type Context = RouteContext<"/api/tables/[id]/fields/[fieldId]">;

/** Renames or edits a field. Changing the type (and its `?preview=1` conversion preview) is Advanced. */
export const PATCH = apiRoute(async (request, context: Context) => {
  assertRole(await getCurrentUser(), "creator");
  if (new URL(request.url).searchParams.get("preview") === "1") {
    throw new ApiError("VALIDATION_ERROR", 400, "Type conversion preview isn't available yet");
  }
  const { id, fieldId } = await context.params;
  const input = await parseJsonBody(request, z.record(z.string(), z.unknown()));
  return Response.json({ field: updateField(id, fieldId, input) });
});

/** 409 with the dependent formulas unless `?force=1`. */
export const DELETE = apiRoute(async (request, context: Context) => {
  assertRole(await getCurrentUser(), "creator");
  const { id, fieldId } = await context.params;
  deleteField(id, fieldId, new URL(request.url).searchParams.get("force") === "1");
  return new Response(null, { status: 204 });
});
