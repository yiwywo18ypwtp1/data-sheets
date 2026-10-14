import type { Aggregates, RowWindowResponse } from "@/lib/domain/api";
import { isConditionComplete, type FilterGroup } from "@/lib/domain/filter";
import type { Row } from "@/lib/domain/row";
import type { RowQuery } from "./api";
import { rangeOf, rowSelectionKey, type Selection } from "./selection";

/**
 * Client state of one open grid: which windows of rows are loaded, the rows
 * themselves, the filtered total and aggregates.
 *
 * Why a plain class read through `useSyncExternalStore` (instead of useState/context
 * or Zustand): each row component subscribes to just its own row, so loading a
 * window or editing a cell re-renders only the affected rows, not all ~1 000 visible
 * cells. The class has no React in it, so it's unit-tested directly. Zustand would
 * work too, but it would wrap the same `useSyncExternalStore` call in a dependency.
 *
 * Memory: rows are kept in blocks of BLOCK_SIZE. At most MAX_BLOCKS blocks stay in
 * memory; when more are loaded, the blocks furthest from what's on screen are evicted
 * (and their rows dropped). Scrolling back simply loads them again.
 */

export const BLOCK_SIZE = 100;
export const MAX_BLOCKS = 12;
/** Waits for scrolling to settle a little, so dragging the scrollbar doesn't request every block it passes. */
export const FETCH_DELAY_MS = 50;

export type FetchWindow = (query: RowQuery, offset: number, limit: number, signal: AbortSignal) => Promise<RowWindowResponse>;

type Block =
  | { status: "loading"; controller: AbortController }
  | { status: "ready"; rowIds: string[] }
  | { status: "error"; message: string };

export type RowStatus = "ready" | "loading" | "error";

export type GridStoreOptions = {
  query: RowQuery;
  fetchWindow: FetchWindow;
  /** The first window, rendered on the server, so the grid starts with data. */
  initialWindow?: RowWindowResponse;
};

export class GridStore {
  private readonly listeners = new Set<() => void>();
  private readonly fetchWindow: FetchWindow;
  private blocks = new Map<number, Block>();
  private rows = new Map<string, Row>();
  private labels = new Map<string, string>();
  /** Bumped whenever the query changes: responses for an older generation are dropped. */
  private generation = 0;
  private wanted: { first: number; last: number } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  query: RowQuery;
  total = 0;
  aggregates: Aggregates = {};
  /** Lives here (not in React state) so only rows whose part of it changes re-render. */
  selection: Selection | null = null;

  constructor({ query, fetchWindow, initialWindow }: GridStoreOptions) {
    this.query = query;
    this.fetchWindow = fetchWindow;
    if (initialWindow) this.applyWindow(0, initialWindow);
  }

  // Arrow functions: `useSyncExternalStore` needs a stable `subscribe` reference.
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private notify() {
    for (const listener of this.listeners) listener();
  }

  getRowAt(index: number): Row | undefined {
    const block = this.blocks.get(Math.floor(index / BLOCK_SIZE));
    if (block?.status !== "ready") return undefined;
    const id = block.rowIds[index % BLOCK_SIZE];
    return id === undefined ? undefined : this.rows.get(id);
  }

  getRowStatus(index: number): RowStatus {
    const block = this.blocks.get(Math.floor(index / BLOCK_SIZE));
    if (!block || block.status === "loading") return "loading";
    return block.status;
  }

  /** An arrow function so it can be handed to formatters without binding. */
  getLabel = (rowId: string): string | undefined => this.labels.get(rowId);

  get loadedBlockCount(): number {
    return this.blocks.size;
  }

  setSelection(selection: Selection | null): void {
    this.selection = selection;
    this.notify();
  }

  getRowSelectionKey(row: number): string {
    return rowSelectionKey(this.selection, row);
  }

  /** "left:right" of the selected columns, for highlighting headers; "" if nothing is selected. */
  getSelectedColumnsKey(): string {
    if (!this.selection) return "";
    const { left, right } = rangeOf(this.selection);
    return `${left}:${right}`;
  }

  /** Called with the rows currently on screen (plus overscan). Loads missing blocks after a short delay. */
  ensureRange(first: number, last: number): void {
    this.wanted = { first, last };
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.loadWanted(), FETCH_DELAY_MS);
  }

  /** Retries the block containing `index` after a failed request. */
  retry(index: number): void {
    const blockIndex = Math.floor(index / BLOCK_SIZE);
    if (this.blocks.get(blockIndex)?.status === "error") {
      this.blocks.delete(blockIndex);
      this.loadBlock(blockIndex);
    }
  }

  /** A new filter/sort/time zone: everything loaded so far belongs to the old result and is dropped. */
  setQuery(query: RowQuery): void {
    this.generation++;
    this.abortAll();
    this.blocks.clear();
    this.rows.clear();
    this.labels.clear();
    this.query = query;
    // Row positions mean something else in the new result, so the old selection would point at other rows.
    this.selection = null;
    this.notify();
    this.loadWanted();
  }

  /** Changes only the time zone. Refetches only if the filter has "today"-style conditions that depend on it. */
  setTimeZone(timeZone: string): void {
    if (timeZone === this.query.timeZone) return;
    const query = { ...this.query, timeZone };
    if (usesRelativeDates(this.query.filter)) this.setQuery(query);
    else this.query = query;
  }

  /**
   * Cancels pending work when the grid unmounts. Cancelled blocks are forgotten, so if
   * React mounts the same store again (StrictMode does this in development) they reload.
   */
  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.abortAll();
  }

  private abortAll() {
    for (const [index, block] of this.blocks) {
      if (block.status === "loading") {
        block.controller.abort();
        this.blocks.delete(index);
      }
    }
  }

  private loadWanted() {
    if (!this.wanted) return;
    const firstBlock = Math.floor(Math.max(0, this.wanted.first) / BLOCK_SIZE);
    const lastBlock = Math.floor(Math.max(0, this.wanted.last) / BLOCK_SIZE);

    // Requests for blocks the user has already scrolled away from are cancelled.
    for (const [index, block] of this.blocks) {
      if (block.status === "loading" && (index < firstBlock - 1 || index > lastBlock + 1)) {
        block.controller.abort();
        this.blocks.delete(index);
      }
    }
    for (let index = firstBlock; index <= lastBlock; index++) {
      if (!this.blocks.has(index)) this.loadBlock(index);
    }
    this.evict((firstBlock + lastBlock) / 2);
  }

  /** Drops the ready blocks furthest from `center` until at most MAX_BLOCKS remain. */
  private evict(center: number) {
    if (this.blocks.size <= MAX_BLOCKS) return;
    const byDistance = [...this.blocks.entries()]
      .filter(([, block]) => block.status === "ready")
      .sort(([a], [b]) => Math.abs(b - center) - Math.abs(a - center));
    for (const [index, block] of byDistance) {
      if (this.blocks.size <= MAX_BLOCKS) break;
      if (block.status === "ready") for (const id of block.rowIds) this.rows.delete(id);
      this.blocks.delete(index);
    }
  }

  private async loadBlock(index: number) {
    const controller = new AbortController();
    const generation = this.generation;
    this.blocks.set(index, { status: "loading", controller });
    this.notify();

    // A response is applied only if this exact request is still the one the block is waiting for:
    // not for an older query (generation), not after it was cancelled or the block was evicted.
    const isCurrent = () => {
      const block = this.blocks.get(index);
      return generation === this.generation && block?.status === "loading" && block.controller === controller;
    };

    try {
      const response = await this.fetchWindow(this.query, index * BLOCK_SIZE, BLOCK_SIZE, controller.signal);
      if (!isCurrent()) return;
      this.applyWindow(index, response);
    } catch (error) {
      if (!isCurrent()) return;
      this.blocks.set(index, { status: "error", message: error instanceof Error ? error.message : "Failed to load rows" });
    }
    this.notify();
  }

  private applyWindow(blockIndex: number, response: RowWindowResponse) {
    for (const row of response.rows) this.rows.set(row.id, row);
    for (const [id, label] of Object.entries(response.linkedLabels)) this.labels.set(id, label);
    this.blocks.set(blockIndex, { status: "ready", rowIds: response.rows.map((row) => row.id) });
    this.total = response.total;
    // Keep the old object when nothing changed, so footer cells don't re-render.
    if (JSON.stringify(response.aggregates) !== JSON.stringify(this.aggregates)) this.aggregates = response.aggregates;
  }
}

const RELATIVE_DATE_OPERATORS = new Set(["isToday", "withinLastDays"]);

/** Whether a filter's result depends on the viewer's "today", i.e. on their time zone. */
export function usesRelativeDates(filter: FilterGroup): boolean {
  const conditions = [...filter.conditions, ...filter.groups.flatMap((group) => group.conditions)];
  return conditions.some((condition) => RELATIVE_DATE_OPERATORS.has(condition.operator) && isConditionComplete(condition));
}
