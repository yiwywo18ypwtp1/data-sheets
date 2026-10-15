import "server-only";
import { ZodError, type z } from "zod";
import { ACTING_USER_HEADER, getCurrentUser } from "./auth";
import { ApiError, zodFieldErrors, type ErrorBody } from "./errors";

/**
 * The one wrapper every Route Handler uses. It exists for two concrete reasons:
 * every endpoint must answer errors in the same `{ error: {…} }` format, and every
 * endpoint must honour the mock network settings. Without it, each of ~12 handlers
 * would repeat the same try/catch and latency code.
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** `MOCK_LATENCY_MS` delays every API call; `MOCK_FAILURE_RATE` (0..1) fails that share of them with 503. */
export async function simulateNetwork(): Promise<void> {
  const latency = Number(process.env.MOCK_LATENCY_MS ?? 0);
  if (latency > 0) await sleep(latency);
  const failureRate = Number(process.env.MOCK_FAILURE_RATE ?? 0);
  if (failureRate > 0 && Math.random() < failureRate) {
    throw new ApiError("MOCK_FAILURE", 503, "Simulated failure (MOCK_FAILURE_RATE)");
  }
}

export function errorResponse(error: unknown): Response {
  if (error instanceof ApiError) return Response.json(error.toBody(), { status: error.status });
  if (error instanceof ZodError) {
    const body: ErrorBody = { error: { code: "VALIDATION_ERROR", message: "Invalid request", fieldErrors: zodFieldErrors(error.issues) } };
    return Response.json(body, { status: 400 });
  }
  console.error(error);
  const body: ErrorBody = { error: { code: "INTERNAL", message: "Something went wrong" } };
  return Response.json(body, { status: 500 });
}

/**
 * A page keeps working after the user is switched in another tab (or in this one, while its
 * edits were still queued). Its writes name the user it was opened for; if the cookie now
 * says someone else, they are refused instead of being saved under the new user's name.
 */
async function assertActingUser(request: Request): Promise<void> {
  const acting = request.headers.get(ACTING_USER_HEADER);
  if (!acting || request.method === "GET" || request.method === "HEAD") return;
  if (acting !== (await getCurrentUser()).id) {
    throw new ApiError("USER_CHANGED", 409, "You switched to another user in this browser. Reload the page to continue as them; this change was not saved.");
  }
}

export function apiRoute<Context>(handler: (request: Request, context: Context) => Promise<Response> | Response) {
  return async (request: Request, context: Context): Promise<Response> => {
    try {
      await simulateNetwork();
      await assertActingUser(request);
      return await handler(request, context);
    } catch (error) {
      return errorResponse(error);
    }
  };
}

export async function parseJsonBody<Schema extends z.ZodType>(request: Request, schema: Schema): Promise<z.output<Schema>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ApiError("VALIDATION_ERROR", 400, "Request body must be valid JSON");
  }
  return schema.parse(body);
}

/** Parses the URL's query string with a zod schema; a ZodError becomes a 400 with field errors. */
export function parseSearchParams<Schema extends z.ZodType>(request: Request, schema: Schema): z.output<Schema> {
  return schema.parse(Object.fromEntries(new URL(request.url).searchParams));
}

/** Versions are sent as strong ETags: `"12"`. Weak validators are accepted too. */
export function etag(version: number): string {
  return `"${version}"`;
}

export function parseIfMatch(request: Request): number | null {
  const header = request.headers.get("if-match");
  if (!header) return null;
  const version = Number(header.replace(/^W\//, "").replaceAll('"', ""));
  return Number.isInteger(version) ? version : -1;
}
