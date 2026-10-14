import type { ErrorBody, RowWindowResponse } from "@/lib/domain/api";
import type { FilterGroup } from "@/lib/domain/filter";
import type { RowOp, RowOpResult } from "@/lib/domain/row";
import { encodeFilterParam, encodeSortParam } from "@/lib/domain/query";
import type { Sort, View } from "@/lib/domain/view";

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
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

let clientId: string | null = null;

/**
 * This browser tab's id. Sent with every request (`x-client-id`), so the realtime events
 * caused by this tab's own writes can be recognised and skipped here.
 */
export function getClientId(): string {
  clientId ??= `tab_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  return clientId;
}

/** Fetches JSON; a non-2xx answer becomes an `ApiRequestError` from the API's error body. A 204 resolves to null. */
export async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("x-client-id", getClientId());
  const response = await fetch(url, { ...init, headers });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ErrorBody | null;
    throw new ApiRequestError(
      response.status,
      body?.error.code ?? "HTTP_ERROR",
      body?.error.message ?? `Request failed (${response.status})`,
      body?.error.fieldErrors,
      body?.error.details,
    );
  }
  if (response.status === 204) return null as T;
  return (await response.json()) as T;
}

export type RowQuery = { filter: FilterGroup; sorts: Sort[]; timeZone: string; groupBy?: string[] };

/** `withGroups`: also return the grouped view's structure (the grid asks until it has it). */
export function fetchRowWindow(tableId: string, query: RowQuery, offset: number, limit: number, signal: AbortSignal, withGroups = false) {
  const params = new URLSearchParams({
    offset: String(offset),
    limit: String(limit),
    filter: encodeFilterParam(query.filter),
    sort: encodeSortParam(query.sorts),
    group: (query.groupBy ?? []).join(","),
    withGroups: withGroups ? "1" : "0",
    tz: query.timeZone,
  });
  return request<RowWindowResponse>(`/api/tables/${tableId}/rows?${params}`, { signal });
}

/**
 * The CSV export of what's on screen: the view's columns, with the current (possibly
 * unsaved) filter, sorts and grouping. The browser downloads it as a stream.
 */
export function exportCsvUrl(tableId: string, viewId: string, query: RowQuery): string {
  const params = new URLSearchParams({
    viewId,
    filter: encodeFilterParam(query.filter),
    sort: encodeSortParam(query.sorts),
    group: (query.groupBy ?? []).join(","),
    tz: query.timeZone,
  });
  return `/api/tables/${tableId}/export?${params}`;
}

/** Starts a download without leaving the page (the response is an attachment). */
export function download(url: string): void {
  const link = document.createElement("a");
  link.href = url;
  link.download = "";
  document.body.append(link);
  link.click();
  link.remove();
}

export async function sendRowBatch(tableId: string, ops: RowOp[]): Promise<RowOpResult[]> {
  const { results } = await request<{ results: RowOpResult[] }>(`/api/tables/${tableId}/rows/batch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ops }),
  });
  return results;
}

export type RecordOption = { id: string; label: string };

export async function searchRecords(tableId: string, q: string, signal: AbortSignal): Promise<RecordOption[]> {
  const params = new URLSearchParams({ q, limit: "20" });
  const { records } = await request<{ records: RecordOption[] }>(`/api/tables/${tableId}/records/search?${params}`, { signal });
  return records;
}

/** Saves a view; `version` goes in If-Match. A 412 carries the current view and version in `details`. */
export function saveView(view: View, version: number) {
  return request<{ view: View; version: number }>(`/api/views/${view.id}`, {
    method: "PUT",
    headers: { "content-type": "application/json", "if-match": `"${version}"` },
    body: JSON.stringify(view),
  });
}

export type PresenceCell = { rowId: string; fieldId: string } | null;

export async function sendPresence(tableId: string, viewId: string, cell: PresenceCell): Promise<void> {
  await request<null>(`/api/tables/${tableId}/presence`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId: getClientId(), viewId, cell }),
  });
}
