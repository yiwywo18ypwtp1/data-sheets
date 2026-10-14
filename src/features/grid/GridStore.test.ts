import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RowWindowResponse } from "@/lib/domain/api";
import type { Row } from "@/lib/domain/row";
import type { RowQuery } from "./api";
import { BLOCK_SIZE, FETCH_DELAY_MS, GridStore, MAX_BLOCKS, usesRelativeDates, type FetchWindow } from "./GridStore";

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

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("GridStore", () => {
  it("starts with the server-rendered window and doesn't refetch it", async () => {
    const { fetchWindow, calls } = controlledFetch();
    const store = new GridStore({ query: baseQuery, fetchWindow, initialWindow: windowOf(0, BLOCK_SIZE) });
    expect(store.total).toBe(TOTAL);
    expect(store.getRowAt(42)?.id).toBe("row_a_42");

    store.ensureRange(0, 60);
    await flush();
    expect(calls).toHaveLength(0);
  });

  it("loads the blocks covering the visible range, after a short delay", async () => {
    const { fetchWindow, calls } = controlledFetch();
    const store = new GridStore({ query: baseQuery, fetchWindow });
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
    const store = new GridStore({ query: baseQuery, fetchWindow });
    store.ensureRange(1000, 1050);
    store.ensureRange(2000, 2050);
    store.ensureRange(3000, 3050);
    await flush();
    expect(calls.map((call) => call.offset)).toEqual([3000]);
  });

  it("cancels requests for blocks scrolled far away", async () => {
    const { fetchWindow, calls } = controlledFetch();
    const store = new GridStore({ query: baseQuery, fetchWindow });
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
    const store = new GridStore({ query: baseQuery, fetchWindow });
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
    const store = new GridStore({ query: baseQuery, fetchWindow });
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
    const store = new GridStore({ query: baseQuery, fetchWindow });
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
    const store = new GridStore({ query: baseQuery, fetchWindow, initialWindow: windowOf(0, BLOCK_SIZE) });
    store.ensureRange(0, 50);
    store.setTimeZone("Europe/Kyiv");
    await flush();
    expect(calls).toHaveLength(0);

    const today = { ...baseQuery, filter: { conjunction: "and" as const, conditions: [{ fieldId: "d", operator: "isToday" as const }], groups: [] } };
    const relative = new GridStore({ query: today, fetchWindow, initialWindow: windowOf(0, BLOCK_SIZE) });
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
