import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RowWindowResponse } from "@/lib/domain/api";
import type { Row, RowOp, RowOpResult } from "@/lib/domain/row";
import { GridStore } from "@/features/grid/GridStore";
import { Outbox, type Locks, type OutboxEdit, type OutboxRecord, type OutboxStorage } from "./outbox";

function memoryStorage(): OutboxStorage & { records: Map<string, OutboxRecord> } {
  const records = new Map<string, OutboxRecord>();
  return {
    records,
    put: async (record) => void records.set(record.ownerId, structuredClone(record)),
    get: async (ownerId) => structuredClone(records.get(ownerId)),
    delete: async (ownerId) => void records.delete(ownerId),
    listForTable: async (tableId) => [...records.values()].filter((record) => record.tableId === tableId),
  };
}

/** Web Locks as the browser keeps them: a name is held until released (a closed tab releases its locks). */
function memoryLocks(): Locks & { held: Set<string> } {
  const held = new Set<string>();
  return {
    held,
    hold: async (name) => {
      held.add(name);
      return () => held.delete(name);
    },
    ifFree: async (name, task) => {
      if (held.has(name)) return null;
      held.add(name);
      try {
        return await task();
      } finally {
        held.delete(name);
      }
    },
  };
}

const edit = (rowId: string, value: string): OutboxEdit => ({ op: "update", rowId, values: { fld: value }, rev: 3 });

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("Outbox", () => {
  it("keeps the newest queue, and removes the record when the queue empties", async () => {
    const storage = memoryStorage();
    const outbox = new Outbox("tbl", "tab_a", "usr_a", storage, memoryLocks());
    await outbox.start();
    outbox.save([edit("row_1", "x")]);
    outbox.save([edit("row_1", "x"), edit("row_2", "y")]);
    await vi.advanceTimersByTimeAsync(200);
    expect(storage.records.get("tab_a")?.edits).toHaveLength(2);

    outbox.save([]);
    await outbox.flush();
    expect(storage.records.has("tab_a")).toBe(false);
  });

  it("takes over the queue of a closed tab once, and leaves an open tab's alone", async () => {
    const storage = memoryStorage();
    const locks = memoryLocks();
    const closed = new Outbox("tbl", "tab_closed", "usr_a", storage, locks);
    const open = new Outbox("tbl", "tab_open", "usr_a", storage, locks);
    await closed.start();
    await open.start();
    closed.save([edit("row_1", "offline edit")]);
    open.save([edit("row_2", "still sending")]);
    await closed.flush();
    await open.flush();
    closed.dispose(); // the tab closes: its lock is released
    await vi.advanceTimersByTimeAsync(0);
    await storage.put({ ownerId: "tab_other_table", userId: "usr_a", tableId: "tbl_other", edits: [edit("row_9", "z")], savedAt: "" });

    const next = new Outbox("tbl", "tab_new", "usr_a", storage, locks);
    await next.start();
    expect(await next.adoptOrphans()).toEqual([edit("row_1", "offline edit")]);
    expect(storage.records.has("tab_closed")).toBe(false);
    expect(storage.records.has("tab_open")).toBe(true);
    // A second tab opening later finds nothing left to take.
    expect(await new Outbox("tbl", "tab_late", "usr_a", storage, locks).adoptOrphans()).toEqual([]);
  });

  it("doesn't hand one user's unsent edits to another user, and keeps them for their own", async () => {
    const storage = memoryStorage();
    const locks = memoryLocks();
    const first = new Outbox("tbl", "tab_a", "usr_a", storage, locks);
    await first.start();
    first.save([edit("row_1", "typed as A")]);
    await first.flush();
    first.dispose(); // A leaves, the user is switched to B
    await vi.advanceTimersByTimeAsync(0);

    const asB = new Outbox("tbl", "tab_b", "usr_b", storage, locks);
    await asB.start();
    expect(await asB.adoptOrphans()).toEqual([]);
    expect(storage.records.get("tab_a")?.edits).toEqual([edit("row_1", "typed as A")]);

    // Back as A, in a new tab: the edits are theirs again.
    const backAsA = new Outbox("tbl", "tab_a2", "usr_a", storage, locks);
    await backAsA.start();
    expect(await backAsA.adoptOrphans()).toEqual([edit("row_1", "typed as A")]);
  });

  it("takes nothing over without Web Locks (an open tab can't be told from a closed one)", async () => {
    const storage = memoryStorage();
    await storage.put({ ownerId: "tab_x", userId: "usr_a", tableId: "tbl", edits: [edit("row_1", "x")], savedAt: "" });
    expect(await new Outbox("tbl", "tab_y", "usr_a", storage, null).adoptOrphans()).toEqual([]);
  });
});

describe("GridStore offline queue", () => {
  const row = (id: string, rev = 1): Row => ({ id, values: { fld: "old" }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", rev });
  const initialWindow: RowWindowResponse = { rows: [row("row_1", 4)], total: 1, aggregates: {}, offset: 0, linkedLabels: {} };

  it("reports its unsent edits as they change, including a batch that couldn't be sent", async () => {
    const saved: OutboxEdit[][] = [];
    let online = false;
    const sendBatch = async (ops: RowOp[]): Promise<RowOpResult[]> => {
      if (!online) throw new TypeError("Failed to fetch");
      return ops.map((op) => ({ ok: true, rowId: op.rowId, row: { ...row(op.rowId, 5), values: "values" in op ? op.values : {} } }));
    };
    const store = new GridStore({ query: { filter: { conjunction: "and", conditions: [], groups: [] }, sorts: [], timeZone: "UTC" }, fields: [], fetchWindow: async () => initialWindow, sendBatch, initialWindow });
    store.setPersistence((edits) => saved.push(edits));

    store.writeCells([{ rowId: "row_1", fieldId: "fld", value: "new" }]);
    expect(saved.at(-1)).toEqual([{ op: "update", rowId: "row_1", values: { fld: "new" }, rev: 4 }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.connection).toBe("offline");
    expect(saved.at(-1)).toHaveLength(1); // still waiting, still stored

    online = true;
    store.resendNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(saved.at(-1)).toEqual([]);
  });

  it("sends adopted edits first, and treats a create the earlier session already sent as done", async () => {
    const sent: RowOp[] = [];
    const sendBatch = async (ops: RowOp[]): Promise<RowOpResult[]> => {
      sent.push(...ops);
      return ops.map((op) => (op.op === "create" ? { ok: false, rowId: op.rowId, error: { code: "CONFLICT", message: "A row with this id already exists" } } : { ok: true, rowId: op.rowId, row: row(op.rowId, 9) }));
    };
    const store = new GridStore({ query: { filter: { conjunction: "and", conditions: [], groups: [] }, sorts: [], timeZone: "UTC" }, fields: [], fetchWindow: async () => initialWindow, sendBatch, initialWindow });
    store.adoptEdits([{ op: "create", rowId: "row_new", values: { fld: "made offline" }, rev: 0 }, { op: "update", rowId: "row_far", values: { fld: "x" }, rev: 7 }]);
    expect(store.total).toBe(2); // the new record shows at the bottom right away
    expect(store.getRowAt(1)?.values.fld).toBe("made offline");
    store.writeCells([{ rowId: "row_1", fieldId: "fld", value: "later" }]);

    await vi.advanceTimersByTimeAsync(0);
    expect(sent.map((op) => op.rowId)).toEqual(["row_new", "row_far", "row_1"]);
    expect(sent[1]).toMatchObject({ op: "update", rev: 7 }); // the row isn't loaded: its rev from then
    expect(store.announcement).not.toContain("Couldn't add");
    expect(store.getRowAt(1)?.id).toBe("row_new");
  });
});
