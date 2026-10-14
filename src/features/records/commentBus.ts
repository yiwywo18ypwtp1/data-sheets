import type { TableEvent } from "@/features/grid/realtime";

/**
 * Comment events from the table's realtime stream, for the open record panel and the
 * mentions inbox. The stream is opened by the grid or the kanban; the panel and the inbox
 * live elsewhere in the tree, so they listen here instead of opening their own.
 */
export type CommentEvent = Extract<TableEvent, { kind: "comment" }>;

const listeners = new Set<(event: CommentEvent) => void>();

export function emitCommentEvent(event: CommentEvent): void {
  for (const listener of listeners) listener(event);
}

export function onCommentEvent(listener: (event: CommentEvent) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
