import { pushToast } from "@/features/grid/toastStore";
import type { CommentEvent } from "./commentBus";

/**
 * A comment mentioning the current user arrived on the open table's stream: a toast that
 * opens the record, and a nudge to the inbox to reload (it also polls, for other tables).
 */
const listeners = new Set<() => void>();

export function onMentionsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notifyMention(event: CommentEvent, openRecord: (rowId: string) => void): void {
  pushToast({ message: `${event.origin.name} mentioned you in a comment.`, action: { label: "Open", run: () => openRecord(event.rowId) } });
  for (const listener of listeners) listener();
}
