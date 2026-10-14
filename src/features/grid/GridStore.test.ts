import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RowWindowResponse } from "@/lib/domain/api";
import type { Field } from "@/lib/domain/field";
import type { Row, RowOp, RowOpResult } from "@/lib/domain/row";
import type { RowQuery } from "./api";
import { BLOCK_SIZE, FETCH_DELAY_MS, GridStore, MAX_BLOCKS, usesRelativeDates, type FetchWindow, type GridStoreOptions, type SendBatch } from "./GridStore";

const TOTAL = 5000;
const baseQuery: RowQuery = { filter: { conjunction: "and", conditions: [], groups: [] }, sorts: [], timeZone: "UTC" };

const row = (index: number, tag = "a"): Row => ({
  id: `row_${tag}_${index}`,
  values: { n: index },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  rev: 1,
});

function windowOf(offset: number, limit: number, tag = "a"): RowWindowResponse {
  const rows = Array.from({ length: Math.max(0, Math.min(limit, TOTAL - offset)) }, (_, i) => row(offset + i, tag));
  return { rows, total: TOTAL, aggregates: { n: { sum: 1, avg: 1 } }, offset, linkedLabels: {} };
}

/** A fetch whose responses are released manually, to control the order requests finish in. */
function controlledFetch() {
  const calls: { offset: number; query: RowQuery; signal: AbortSignal; resolve: (tag?: string) => void; reject: (error: Error) => void }[] = [];
  const fetchWindow: FetchWindow = (query, offset, limit, signal) =>
    new Promise((resolve, reject) => {
      calls.push({ offset, query, signal, resolve: (tag) => resolve(windowOf(offset, limit, tag)), reject });
    });
  return { fetchWindow, calls };
}

const flush = () => vi.advanceTimersByTimeAsync(FETCH_DELAY_MS);

function createStore(options: Partial<GridStoreOptions> & Pick<GridStoreOptions, "query" | "fetchWindow">) {
  return new GridStore({ fields: [], sendBatch: async () => [], ...options });
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("GridStore", () => {
  it("starts with the server-rendered window and doesn't refetch it", async () => {
    const { fetchWindow, calls } = controlledFetch();
    const store = createStore({ query: baseQuery, fetchWindow, initialWindow: windowOf(0, BLOCK_SIZE) });
    expect(store.total).toBe(TOTAL);
    expect(store.getRowAt(42)?.id).toBe("row_a_42");

    store.ensureRange(0, 60);
    await flush();
    expect(calls).toHaveLength(0);
  });

  it("loads the blocks covering the visible range, after a short delay", async () => {
    const { fetchWindow, calls } = controlledFetch();
    const store = createStore({ query: baseQuery, fetchWindow });
    const listener = vi.fn();
    store.subscribe(listener);

    store.ensureRange(250, 320);
    expect(calls).toHaveLength(0); // debounced
    await flush();
    expect(calls.map((call) => call.offset)).toEqual([200, 300]);
    expect(store.getRowStatus(250)).toBe("loading");
    expect(store.getRowAt(250)).toBeUndefined();

    calls[0].resolve();
    await vi.runAllTimersAsync();
    expect(store.getRowAt(250)?.id).toBe("row_a_250");
    expect(store.getRowStatus(310)).toBe("loading");
    expect(listener).toHaveBeenCalled();
  });

  it("only requests the last range when scrolled quickly", async () => {
    const { fetchWindow, calls } = controlledFetch();
    const store = createStore({ query: baseQuery, fetchWindow });
    store.ensureRange(1000, 1050);
    store.ensureRange(2000, 2050);
    store.ensureRange(3000, 3050);
    await flush();
    expect(calls.map((call) => call.offset)).toEqual([3000]);
  });

  it("cancels requests for blocks scrolled far away", async () => {
    const { fetchWindow, calls } = controlledFetch();
    const store = createStore({ query: baseQuery, fetchWindow });
    store.ensureRange(0, 50);
    await flush();
    store.ensureRange(4000, 4050);
    await flush();
    expect(calls[0].signal.aborted).toBe(true);
    calls[0].resolve(); // a late answer for an abandoned block is ignored
    await vi.runAllTimersAsync();
    expect(store.getRowAt(10)).toBeUndefined();
  });

  it("drops responses that belong to an older query, even if they arrive last", async () => {
    const { fetchWindow, calls } = controlledFetch();
    const store = createStore({ query: baseQuery, fetchWindow });
    store.ensureRange(0, 50);
    await flush();
    const oldRequest = calls[0];

    store.setQuery({ ...baseQuery, sorts: [{ fieldId: "n", direction: "desc" }] });
    expect(oldRequest.signal.aborted).toBe(true);
    const newRequest = calls[1];
    expect(newRequest.query.sorts).toEqual([{ fieldId: "n", direction: "desc" }]);

    newRequest.resolve("new");
    oldRequest.resolve("old"); // slow, stale response arrives after the new one
    await vi.runAllTimersAsync();
    expect(store.getRowAt(0)?.id).toBe("row_new_0");
  });

  it("keeps at most MAX_BLOCKS blocks, evicting the ones furthest away", async () => {
    const fetchWindow: FetchWindow = async (_query, offset, limit) => windowOf(offset, limit);
    const store = createStore({ query: baseQuery, fetchWindow });
    for (let block = 0; block < MAX_BLOCKS + 8; block++) {
      store.ensureRange(block * BLOCK_SIZE, block * BLOCK_SIZE + 50);
      await vi.runAllTimersAsync();
    }
    expect(store.loadedBlockCount).toBeLessThanOrEqual(MAX_BLOCKS);
    expect(store.getRowAt(0)).toBeUndefined(); // the first block was evicted
    expect(store.getRowAt((MAX_BLOCKS + 7) * BLOCK_SIZE)?.id).toBeDefined();
  });

  it("marks a failed block and retries it on demand", async () => {
    const { fetchWindow, calls } = controlledFetch();
    const store = createStore({ query: baseQuery, fetchWindow });
    store.ensureRange(100, 150);
    await flush();
    calls[0].reject(new Error("Simulated failure"));
    await vi.runAllTimersAsync();
    expect(store.getRowStatus(120)).toBe("error");

    store.retry(120);
    expect(calls).toHaveLength(2);
    calls[1].resolve();
    await vi.runAllTimersAsync();
    expect(store.getRowAt(120)?.id).toBe("row_a_120");
  });

  it("refetches on a time zone change only when the filter depends on today", async () => {
    const { fetchWindow, calls } = controlledFetch();
    const store = createStore({ query: baseQuery, fetchWindow, initialWindow: windowOf(0, BLOCK_SIZE) });
    store.ensureRange(0, 50);
    store.setTimeZone("Europe/Kyiv");
    await flush();
    expect(calls).toHaveLength(0);

    const today = { ...baseQuery, filter: { conjunction: "and" as const, conditions: [{ fieldId: "d", operator: "isToday" as const }], groups: [] } };
    const relative = createStore({ query: today, fetchWindow, initialWindow: windowOf(0, BLOCK_SIZE) });
    relative.ensureRange(0, 50);
    relative.setTimeZone("Europe/Kyiv");
    expect(calls).toHaveLength(1);
    expect(calls[0].query.timeZone).toBe("Europe/Kyiv");
  });
});

describe("usesRelativeDates", () => {
  it("ignores incomplete conditions", () => {
    expect(
      usesRelativeDates({ conjunction: "and", conditions: [{ fieldId: "d", operator: "withinLastDays", value: null }], groups: [] }),
    ).toBe(false);
  });
});

describe("GridStore selection", () => {
  it("notifies subscribers and exposes per-row keys; a new query clears it", () => {
    const store = createStore({ query: baseQuery, fetchWindow: async (_q, offset, limit) => windowOf(offset, limit) });
    const listener = vi.fn();
    store.subscribe(listener);
    store.setSelection({ anchor: { row: 3, col: 1 }, focus: { row: 5, col: 2 } });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getRowSelectionKey(4)).toBe("1:2:0:0:-1");
    expect(store.getSelectedColumnsKey()).toBe("1:2");

    store.setQuery({ ...baseQuery, sorts: [{ fieldId: "n", direction: "asc" }] });
    expect(store.selection).toBeNull();
    expect(store.getRowSelectionKey(4)).toBe("");
  });
});

describe("GridStore writes", () => {
  const fields: Field[] = [
    { id: "n", name: "N", type: "number", precision: 0 },
    { id: "double", name: "Double", type: "formula", expression: "{n} * 2", resultType: "number" },
    { id: "note", name: "Note", type: "text" },
  ];
  const confirmed = (op: Extract<RowOp, { op: "update" }>): RowOpResult => ({
    ok: true,
    rowId: op.rowId,
    row: { ...row(Number(op.rowId.split("_").pop())), values: { ...op.values }, rev: op.rev + 1 },
  });

  /** A server whose batches are answered manually. */
  function controlledServer() {
    const batches: { ops: RowOp[]; answer: (results: RowOpResult[] | Error) => void }[] = [];
    const sendBatch: SendBatch = (ops) =>
      new Promise((resolve, reject) => {
        batches.push({ ops, answer: (results) => (results instanceof Error ? reject(results) : resolve(results)) });
      });
    return { sendBatch, batches };
  }
  const setup = () => {
    const server = controlledServer();
    const store = createStore({ query: baseQuery, fields, fetchWindow: async (_q, o, l) => windowOf(o, l), sendBatch: server.sendBatch, initialWindow: windowOf(0, BLOCK_SIZE) });
    return { store, ...server };
  };

  it("shows an edit immediately, recomputes the row's formulas, and sends one batch per tick", async () => {
    const { store, batches } = setup();
    store.writeCells([
      { rowId: "row_a_1", fieldId: "n", value: 21 },
      { rowId: "row_a_1", fieldId: "note", value: "hi" },
      { rowId: "row_a_2", fieldId: "n", value: 5 },
    ]);
    expect(store.getRowAt(1)?.values).toMatchObject({ n: 21, double: 42, note: "hi" });
    expect(store.getRowAt(1)?.saving).toBe(true);
    expect(batches).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(0);
    expect(batches).toHaveLength(1);
    expect(batches[0].ops).toEqual([
      { op: "update", rowId: "row_a_1", values: { n: 21, note: "hi" }, rev: 1 },
      { op: "update", rowId: "row_a_2", values: { n: 5 }, rev: 1 },
    ]);
  });

  it("adopts the server's row on success", async () => {
    const { store, batches } = setup();
    store.writeCells([{ rowId: "row_a_1", fieldId: "n", value: 7 }]);
    await vi.advanceTimersByTimeAsync(0);
    batches[0].answer(batches[0].ops.map((op) => confirmed(op as Extract<RowOp, { op: "update" }>)));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getRowAt(1)?.rev).toBe(2);
    expect(store.getRowAt(1)?.saving).toBeUndefined();
    expect(store.hasPendingWrites).toBe(false);
  });

  it("rolls back only the failed op, keeps the others, and reports the cell error", async () => {
    const { store, batches } = setup();
    store.writeCells([
      { rowId: "row_a_1", fieldId: "n", value: -5 },
      { rowId: "row_a_2", fieldId: "n", value: 9 },
    ]);
    await vi.advanceTimersByTimeAsync(0);
    batches[0].answer([
      { ok: false, rowId: "row_a_1", error: { code: "VALIDATION_ERROR", message: "Some values are invalid", fieldErrors: { n: "Must be ≥ 0" } } },
      confirmed(batches[0].ops[1] as Extract<RowOp, { op: "update" }>),
    ]);
    await vi.advanceTimersByTimeAsync(0);

    expect(store.getRowAt(1)?.values.n).toBe(1); // back to the confirmed value
    expect(store.getRowAt(1)?.saveErrors).toEqual({ n: "Must be ≥ 0" });
    expect(store.getRowAt(2)?.values.n).toBe(9);
    expect(store.announcement).toBe("1 change couldn't be saved");
  });

  it("rolls back a whole batch on a network error", async () => {
    const { store, batches } = setup();
    store.writeCells([{ rowId: "row_a_3", fieldId: "n", value: 30 }]);
    await vi.advanceTimersByTimeAsync(0);
    batches[0].answer(new Error("Simulated failure"));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getRowAt(3)?.values.n).toBe(3);
    expect(store.getRowAt(3)?.saveErrors?.n).toBe("Not saved: Simulated failure");
  });

  it("sends batches one after another, keeping later edits applied while earlier ones settle", async () => {
    const { store, batches } = setup();
    store.writeCells([{ rowId: "row_a_1", fieldId: "n", value: 10 }]);
    await vi.advanceTimersByTimeAsync(0);
    store.writeCells([{ rowId: "row_a_1", fieldId: "n", value: 11 }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(batches).toHaveLength(1); // the second waits for the first

    batches[0].answer([{ ok: false, rowId: "row_a_1", error: { code: "X", message: "nope" } }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getRowAt(1)?.values.n).toBe(11); // the later edit is still shown
    expect(batches).toHaveLength(2);
    expect(batches[1].ops[0]).toMatchObject({ values: { n: 11 } });

    // re-editing the failed cell clears its error
    expect(store.getRowAt(1)?.saveErrors).toEqual({ n: "nope" });
    store.writeCells([{ rowId: "row_a_1", fieldId: "n", value: 12 }]);
    expect(store.getRowAt(1)?.saveErrors).toBeUndefined();
  });
});

describe("GridStore adding and deleting rows", () => {
  function setup(fetchWindow: FetchWindow = async (_q, o, l) => windowOf(o, l)) {
    const batches: { ops: RowOp[]; answer: (results: RowOpResult[]) => void }[] = [];
    const sendBatch: SendBatch = (ops) => new Promise((resolve) => batches.push({ ops, answer: resolve }));
    const store = createStore({ query: baseQuery, fetchWindow, sendBatch, initialWindow: windowOf(0, BLOCK_SIZE) });
    return { store, batches };
  }

  it("adds a row at the bottom with a client id, and drops it if the server refuses", async () => {
    const { store, batches } = setup();
    const index = store.addRow({ n: 1 });
    expect(index).toBe(TOTAL);
    expect(store.total).toBe(TOTAL + 1);
    const id = store.getRowAt(index)!.id;
    expect(id).toMatch(/^row_/);

    await vi.advanceTimersByTimeAsync(0);
    expect(batches[0].ops).toEqual([{ op: "create", rowId: id, values: { n: 1 } }]);
    batches[0].answer([{ ok: false, rowId: id, error: { code: "X", message: "no" } }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.total).toBe(TOTAL);
    expect(store.getRowAt(index)).toBeUndefined();
    expect(store.announcement).toBe("Couldn't add the record");
  });

  it("keeps a confirmed new row at the bottom until a window returns it", async () => {
    let includeNew: Row | null = null;
    const { store, batches } = setup(async (_q, offset, limit) => {
      const window = windowOf(offset, limit);
      return includeNew ? { ...window, rows: [...window.rows.slice(0, -1), includeNew], total: TOTAL + 1 } : window;
    });
    const index = store.addRow();
    const id = store.getRowAt(index)!.id;
    await vi.advanceTimersByTimeAsync(0);
    const created = { ...row(0), id, rev: 1 };
    batches[0].answer([{ ok: true, rowId: id, row: created }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getRowAt(index)?.rev).toBe(1);

    includeNew = created;
    store.setQuery({ ...baseQuery }); // any reload that returns the row
    store.ensureRange(0, 10);
    await vi.runAllTimersAsync();
    expect(store.total).toBe(TOTAL + 1); // counted once, not twice
  });

  it("marks rows as deleting, then reloads the windows once the server confirms", async () => {
    const fetchWindow = vi.fn(async (_q: RowQuery, o: number, l: number) => windowOf(o, l));
    const { store, batches } = setup(fetchWindow);
    store.ensureRange(0, 10);
    store.deleteRows(["row_a_3"]);
    expect(store.getRowAt(3)?.deleting).toBe(true);

    await vi.advanceTimersByTimeAsync(0);
    expect(batches[0].ops).toEqual([{ op: "delete", rowId: "row_a_3", rev: 1 }]);
    batches[0].answer([{ ok: true, rowId: "row_a_3", row: null }]);
    await vi.runAllTimersAsync();
    expect(fetchWindow).toHaveBeenCalled(); // windows reloaded
  });
});
