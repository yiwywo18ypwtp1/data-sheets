import { apiRoute, parseJsonBody } from "@/server/api";
import { ApiError } from "@/server/errors";
import { submitForm } from "@/server/forms";
import { z } from "zod";

const STATUS = { INVALID: 400, GONE: 404, CHANGED: 409, RATE_LIMITED: 429, UNAVAILABLE: 503 } as const;

/**
 * A public form's submission, for API clients (the page itself uses a Server Action
 * that runs the same `submitForm`). No login: anyone with the link may answer.
 * Body: `{ submissionId, version, answers, locale?, timeZone?, website? }`.
 */
export const POST = apiRoute(async (request, context: RouteContext<"/api/forms/[viewId]">) => {
  const { viewId } = await context.params;
  const body = await parseJsonBody(request, z.unknown());
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  const result = submitForm(viewId, body, ip);
  if (result.ok) return Response.json(result, { status: 201 });
  throw new ApiError(result.code === "INVALID" ? "VALIDATION_ERROR" : result.code === "GONE" ? "NOT_FOUND" : "CONFLICT", STATUS[result.code], result.message, {
    fieldErrors: result.fieldErrors,
    details: { reason: result.code },
  });
});
