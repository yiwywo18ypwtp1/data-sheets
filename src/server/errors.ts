import "server-only";
import type { ErrorBody as SharedErrorBody } from "@/lib/domain/api";

export type ErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "PRECONDITION_FAILED"
  | "USER_CHANGED"
  | "MOCK_FAILURE"
  | "INTERNAL";

/** The API's single error format, with the server's narrower set of codes. */
export type ErrorBody = SharedErrorBody & { error: { code: ErrorCode } };

/** Thrown by server code for expected failures; Route Handlers turn it into an `ErrorBody` response. */
export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly status: number,
    message: string,
    readonly extra: { fieldErrors?: Record<string, string>; details?: unknown } = {},
  ) {
    super(message);
    this.name = "ApiError";
  }

  toBody(): ErrorBody {
    return { error: { code: this.code, message: this.message, ...this.extra } };
  }
}

export const notFound = (what: string) => new ApiError("NOT_FOUND", 404, `${what} not found`);

/** Zod issues as `{ "path.to.field": message }`, first message per path. */
export function zodFieldErrors(issues: readonly { path: PropertyKey[]; message: string }[]): Record<string, string> {
  const fieldErrors: Record<string, string> = {};
  for (const issue of issues) {
    const key = issue.path.map(String).join(".") || "_";
    fieldErrors[key] ??= issue.message;
  }
  return fieldErrors;
}
