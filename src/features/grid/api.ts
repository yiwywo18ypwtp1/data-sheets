import type { ErrorBody, RowWindowResponse } from "@/lib/domain/api";
import type { FilterGroup } from "@/lib/domain/filter";
import { encodeFilterParam, encodeSortParam } from "@/lib/domain/query";
import type { Sort } from "@/lib/domain/view";

/**
 * Client-side calls to the Route Handlers. Components never build URLs or parse
 * error bodies themselves; they get typed data or an `ApiRequestError`.
 */

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fieldErrors?: Record<string, string>,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ErrorBody | null;
    throw new ApiRequestError(
      response.status,
      body?.error.code ?? "HTTP_ERROR",
      body?.error.message ?? `Request failed (${response.status})`,
      body?.error.fieldErrors,
    );
  }
  return (await response.json()) as T;
}

export type RowQuery = { filter: FilterGroup; sorts: Sort[]; timeZone: string };

export function fetchRowWindow(tableId: string, query: RowQuery, offset: number, limit: number, signal: AbortSignal) {
  const params = new URLSearchParams({
    offset: String(offset),
    limit: String(limit),
    filter: encodeFilterParam(query.filter),
    sort: encodeSortParam(query.sorts),
    tz: query.timeZone,
  });
  return request<RowWindowResponse>(`/api/tables/${tableId}/rows?${params}`, { signal });
}
