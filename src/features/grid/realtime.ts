import type { Comment } from "@/lib/domain/comment";
import type { Row } from "@/lib/domain/row";
import type { View } from "@/lib/domain/view";
import { getClientId } from "./api";

/** Mirrors the server's event shapes (server/events.ts). */
export type Origin = { userId: string; name: string; clientId: string | null };
export type RowChange = { row: Row; fields: string[]; created?: true };
export type TableEvent = { seq: number; tableId: string; at: string } & (
  | { kind: "rows"; origin: Origin; rows: RowChange[]; deleted: string[] }
  | { kind: "reload"; origin: Origin }
  | { kind: "schema"; origin: Origin; deletedFieldId?: string }
  | { kind: "view"; origin: Origin; view: View; version: number }
  | { kind: "comment"; origin: Origin; rowId: string; comment?: Comment; deletedId?: string }
);
export type PresenceEntry = { clientId: string; userId: string; name: string; color: string; viewId: string | null; cell: { rowId: string; fieldId: string } | null };

export type RealtimeStatus = "connecting" | "live" | "reconnecting";

type Handlers = {
  onEvent: (event: TableEvent) => void;
  /** Events were lost for good (the log was pruned or reset): reload everything. */
  onReset: () => void;
  onPresence: (entries: PresenceEntry[]) => void;
  onStatus: (status: RealtimeStatus) => void;
};

const RECONNECT_MS = 1000;

/**
 * Subscribes to a table's SSE stream. It remembers the last event number and checks
 * each new one follows it: a jump means events were lost (REALTIME_DROP_RATE, a proxy),
 * so it reconnects with `?since=<last>` and the server replays the missing ones. A dropped
 * connection is reconnected the same way. Events from this tab's own writes are skipped
 * by the caller (`origin.clientId`).
 */
export function connectRealtime(tableId: string, handlers: Handlers): () => void {
  let last: number | null = null;
  let source: EventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const open = () => {
    if (stopped) return;
    handlers.onStatus(last === null ? "connecting" : "reconnecting");
    const params = new URLSearchParams({ clientId: getClientId() });
    if (last !== null) params.set("since", String(last));
    const current = new EventSource(`/api/tables/${tableId}/events?${params}`);
    source = current;

    const reconnect = () => {
      current.close();
      if (source !== current || stopped) return;
      source = null;
      handlers.onStatus("reconnecting");
      timer = setTimeout(open, RECONNECT_MS);
    };

    current.addEventListener("hello", (message) => {
      handlers.onStatus("live");
      last ??= (JSON.parse(message.data) as { since: number }).since;
    });
    current.addEventListener("change", (message) => {
      const event = JSON.parse(message.data) as TableEvent;
      if (last !== null && event.seq <= last) return; // already seen (a replay overlapping what arrived live)
      if (last !== null && event.seq !== last + 1) {
        // A gap: ask again from the last event we have; the server replays from its log.
        return reconnect();
      }
      last = event.seq;
      handlers.onEvent(event);
    });
    current.addEventListener("tick", (message) => {
      // The server is further than what arrived here: the last events were lost.
      const { seq } = JSON.parse(message.data) as { seq: number };
      if (last !== null && seq > last) reconnect();
    });
    current.addEventListener("reset", (message) => {
      last = Number(message.lastEventId);
      handlers.onReset();
    });
    current.addEventListener("presence", (message) => handlers.onPresence(JSON.parse(message.data) as PresenceEntry[]));
    // EventSource would reconnect by itself, but with its own id bookkeeping; we keep ours.
    current.onerror = reconnect;
  };

  open();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    source?.close();
  };
}
