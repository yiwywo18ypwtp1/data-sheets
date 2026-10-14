import { z } from "zod";
import { isValidTimeZone } from "@/lib/domain/field";
import { apiRoute, parseJsonBody, parseSearchParams } from "@/server/api";
import { assertRole, getCurrentUser, originOf } from "@/server/auth";
import { deleteField, previewFieldChange, updateField } from "@/server/fields";

type Context = RouteContext<"/api/tables/[id]/fields/[fieldId]">;

const isValidLocale = (locale: string) => {
  try {
    return Intl.NumberFormat.supportedLocalesOf(locale).length > 0;
  } catch {
    return false;
  }
};

const querySchema = z.object({
  preview: z.enum(["1"]).optional(),
  /** The viewer's locale and zone: text values convert the way they read them ("1 234,5", "12.03.2026"). */
  locale: z.string().refine(isValidLocale, "Unknown locale").default("en-US"),
  tz: z.string().refine(isValidTimeZone, "Unknown time zone").default("UTC"),
});

/**
 * Edits a field: rename, settings, or a type change. A change that alters stored values
 * converts them all in one transaction; `?preview=1` only reports what the conversion
 * would do (how many values convert, how many become empty, examples).
 */
export const PATCH = apiRoute(async (request, context: Context) => {
  const user = await getCurrentUser();
  assertRole(user, "creator");
  const { preview, locale, tz } = parseSearchParams(request, querySchema);
  const { id, fieldId } = await context.params;
  const input = await parseJsonBody(request, z.record(z.string(), z.unknown()));
  if (preview) return Response.json({ preview: previewFieldChange(id, fieldId, input, { locale, timeZone: tz }) });
  return Response.json({ field: updateField(id, fieldId, input, originOf(user, request), { locale, timeZone: tz }) });
});

/** 409 with the dependent formulas unless `?force=1`. */
export const DELETE = apiRoute(async (request, context: Context) => {
  const user = await getCurrentUser();
  assertRole(user, "creator");
  const { id, fieldId } = await context.params;
  deleteField(id, fieldId, new URL(request.url).searchParams.get("force") === "1", originOf(user, request));
  return new Response(null, { status: 204 });
});
