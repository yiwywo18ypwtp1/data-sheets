import "server-only";

export type ErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "PRECONDITION_FAILED"
  | "MOCK_FAILURE"
  | "INTERNAL";

/** The API's single error format: `{ error: { code, message, fieldErrors?, details? } }`. */
export type ErrorBody = {
  error: { code: ErrorCode; message: string; fieldErrors?: Record<string, string>; details?: unknown };
};

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
