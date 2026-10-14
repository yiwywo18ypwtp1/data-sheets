import type { CellHistoryResponse, RowResponse } from "@/lib/domain/api";
import type { Comment, Mention } from "@/lib/domain/comment";
import { request } from "@/features/grid/api";

export function fetchRecord(tableId: string, rowId: string, signal?: AbortSignal): Promise<RowResponse> {
  return request<RowResponse>(`/api/tables/${tableId}/rows/${rowId}`, { signal });
}

export function fetchCellHistory(tableId: string, rowId: string, options: { fieldId?: string | null; before?: number | null }, signal?: AbortSignal): Promise<CellHistoryResponse> {
  const params = new URLSearchParams();
  if (options.fieldId) params.set("fieldId", options.fieldId);
  if (options.before) params.set("before", String(options.before));
  return request<CellHistoryResponse>(`/api/tables/${tableId}/rows/${rowId}/history?${params}`, { signal });
}

export function fetchComments(tableId: string, rowId: string, signal?: AbortSignal): Promise<{ comments: Comment[] }> {
  return request<{ comments: Comment[] }>(`/api/tables/${tableId}/rows/${rowId}/comments`, { signal });
}

export function postComment(tableId: string, rowId: string, body: string): Promise<{ comment: Comment }> {
  return request<{ comment: Comment }>(`/api/tables/${tableId}/rows/${rowId}/comments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body }),
  });
}

export function deleteComment(tableId: string, commentId: string): Promise<null> {
  return request<null>(`/api/tables/${tableId}/comments/${commentId}`, { method: "DELETE" });
}

export type UserOption = { id: string; name: string };
let users: Promise<UserOption[]> | null = null;

/** Everyone who can be mentioned; asked once per page (a failed answer is asked again). */
export function fetchUsers(): Promise<UserOption[]> {
  users ??= request<{ users: UserOption[] }>("/api/users").then(
    (response) => response.users,
    (error: unknown) => {
      users = null;
      throw error;
    },
  );
  return users;
}

export function fetchMentions(): Promise<{ mentions: Mention[]; unread: number }> {
  return request<{ mentions: Mention[]; unread: number }>("/api/mentions");
}

export function markMentionsRead(commentIds?: string[]): Promise<null> {
  return request<null>("/api/mentions/read", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(commentIds ? { commentIds } : {}) });
}
