import "server-only";
import { EventEmitter } from "node:events";
import type { Comment } from "@/lib/domain/comment";
import type { Row } from "@/lib/domain/row";
import type { View } from "@/lib/domain/view";
import { now } from "./clock";
import { getDb } from "./db";

/**
 * Realtime: every change to a table is appended to an event log with a per-table
 * sequence number. Row writes and view saves log it in the same transaction as the
 * change, so an event exists if and only if the change was committed; schema changes
 * log it right after (they recompute in several steps). SSE streams read the log; a client that
 * missed events (dropped connection, REALTIME_DROP_RATE) asks again from the last
 * number it saw and gets them replayed from the log.
 */

/** Who made a change: the user, and the browser tab (so a tab can skip its own events). */
export type Origin = { userId: string; name: string; clientId: string | null };

export type RowChange = {
  row: Row;
  /** Cells written directly by this change (not recomputed ones): what conflicts are about. */
  fields: string[];
  created?: true;
};

export type EventPayload =
  | { kind: "rows"; origin: Origin; rows: RowChange[]; deleted: string[] }
  /** Many rows changed (a formula recomputed everywhere): reload the windows. */
  | { kind: "reload"; origin: Origin }
  /** Fields changed: reload the schema. `deletedFieldId` lets an open editor of that field explain why it closed. */
  | { kind: "schema"; origin: Origin; deletedFieldId?: string }
  | { kind: "view"; origin: Origin; view: View; version: number }
  /** A comment was added to a record (`comment`) or deleted (`deletedId`). */
  | { kind: "comment"; origin: Origin; rowId: string; comment?: Comment; deletedId?: string };

export type TableEvent = { seq: number; tableId: string; at: string } & EventPayload;

/** Old events are pruned; a client further behind than this reloads instead of replaying. */
const KEEP_EVENTS = 5000;
const MAX_REPLAY = 1000;

type Shared = { bus: EventEmitter; presence: Map<string, Map<string, Presence>> };
// On globalThis, like the DB: route handlers and Server Actions are separate bundles (see rows.ts).
const shared = globalThis as unknown as { realtime?: Shared };
shared.realtime ??= { bus: new EventEmitter().setMaxListeners(0), presence: new Map() };
const { bus, presence } = shared.realtime;

/** Appends an event. Call inside the transaction of the change; listeners are woken after it commits. */
export function appendEvent(tableId: string, payload: EventPayload): number {
  const db = getDb();
  const { seq } = db.prepare("SELECT coalesce(max(seq), 0) + 1 AS seq FROM events WHERE table_id = ?").get(tableId) as { seq: number };
  db.prepare("INSERT INTO events (table_id, seq, payload, created_at) VALUES (?, ?, ?, ?)").run(tableId, seq, JSON.stringify(payload), now().toISOString());
  if (seq % 500 === 0) db.prepare("DELETE FROM events WHERE table_id = ? AND seq <= ?").run(tableId, seq - KEEP_EVENTS);
  // better-sqlite3 transactions are synchronous: a microtask runs after the commit.
  queueMicrotask(() => bus.emit(`table:${tableId}`));
  return seq;
}

export function latestSeq(tableId: string): number {
  return (getDb().prepare("SELECT coalesce(max(seq), 0) AS seq FROM events WHERE table_id = ?").get(tableId) as { seq: number }).seq;
}

/**
 * Up to MAX_REPLAY events after `since`, oldest first. `gap` is true when the log no
 * longer reaches back to `since` (pruned): the client must reload instead of replaying.
 */
export function eventsSince(tableId: string, since: number): { events: TableEvent[]; gap: boolean } {
  const records = getDb()
    .prepare("SELECT seq, payload, created_at FROM events WHERE table_id = ? AND seq > ? ORDER BY seq LIMIT ?")
    .all(tableId, since, MAX_REPLAY) as { seq: number; payload: string; created_at: string }[];
  const events = records.map((record) => ({ seq: record.seq, tableId, at: record.created_at, ...(JSON.parse(record.payload) as EventPayload) }));
  return { events, gap: events.length > 0 && events[0].seq !== since + 1 };
}

export function onTableEvents(tableId: string, listener: () => void): () => void {
  bus.on(`table:${tableId}`, listener);
  return () => bus.off(`table:${tableId}`, listener);
}

// ---- presence (in memory: it only matters while people are connected) ----------------

export type Presence = {
  clientId: string;
  userId: string;
  name: string;
  color: string;
  viewId: string | null;
  cell: { rowId: string; fieldId: string } | null;
  seenAt: number;
};

const PRESENCE_TTL_MS = 45_000;
const COLORS = ["#e11d48", "#7c3aed", "#0891b2", "#16a34a", "#d97706", "#db2777", "#4f46e5", "#0d9488"];

/** A stable colour per user, so the same person has the same frame in every tab. */
export function colorOf(userId: string): string {
  let hash = 0;
  for (const char of userId) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return COLORS[Math.abs(hash) % COLORS.length];
}

function tablePresence(tableId: string): Map<string, Presence> {
  let entries = presence.get(tableId);
  if (!entries) presence.set(tableId, (entries = new Map()));
  return entries;
}

export function listPresence(tableId: string): Presence[] {
  const entries = tablePresence(tableId);
  const cutoff = Date.now() - PRESENCE_TTL_MS;
  for (const [clientId, entry] of entries) if (entry.seenAt < cutoff) entries.delete(clientId);
  return [...entries.values()];
}

export function setPresence(tableId: string, entry: Omit<Presence, "seenAt" | "color">): void {
  tablePresence(tableId).set(entry.clientId, { ...entry, color: colorOf(entry.userId), seenAt: Date.now() });
  bus.emit(`presence:${tableId}`);
}

export function removePresence(tableId: string, clientId: string): void {
  if (tablePresence(tableId).delete(clientId)) bus.emit(`presence:${tableId}`);
}

export function onPresence(tableId: string, listener: () => void): () => void {
  bus.on(`presence:${tableId}`, listener);
  return () => bus.off(`presence:${tableId}`, listener);
}
