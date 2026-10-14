import type { Aggregates, RowWindowResponse } from "@/lib/domain/api";
import type { CellValue } from "@/lib/domain/cell";
import type { Field } from "@/lib/domain/field";
import { isConditionComplete, type FilterGroup } from "@/lib/domain/filter";
import { newId } from "@/lib/domain/ids";
import { MAX_BATCH_OPS, type Row, type RowOp, type RowOpResult } from "@/lib/domain/row";
import type { RowQuery } from "./api";
import { buildFormulaContext, displayRow, type DisplayRow, type FormulaContext, type PendingEdit } from "./optimistic";
import { rangeOf, rowSelectionKey, type Selection } from "./selection";

/**
 * Client state of one open grid: which windows of rows are loaded, the rows
 * themselves, the filtered total and aggregates, the selection, the cell being
 * edited, and edits waiting for the server.
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
export type SendBatch = (ops: RowOp[]) => Promise<RowOpResult[]>;

type Block =
  | { status: "loading"; controller: AbortController }
  | { status: "ready"; rowIds: string[] }
  | { status: "error"; message: string };

export type RowStatus = "ready" | "loading" | "error";
export type CellChange = { rowId: string; fieldId: string; value: CellValue };
/** `initialText` is what the editor opens with: the typed character, or null to start from the cell's value. */
export type EditingState = { row: number; col: number; initialText: string | null };

export type GridStoreOptions = {
  query: RowQuery;
  /** All fields of the table: needed to recompute formulas optimistically. */
  fields: Field[];
  fetchWindow: FetchWindow;
  sendBatch: SendBatch;
  /** The first window, rendered on the server, so the grid starts with data. */
  initialWindow?: RowWindowResponse;
};

export class GridStore {
  private readonly listeners = new Set<() => void>();
  private readonly fetchWindow: FetchWindow;
  private readonly sendBatch: SendBatch;
  private readonly formulas: FormulaContext;
  private blocks = new Map<number, Block>();
  /** Rows exactly as the server last confirmed them. */
  private rows = new Map<string, Row>();
  private labels = new Map<string, string>();
  /** Bumped whenever the query changes: responses for an older generation are dropped. */
  private generation = 0;
  private wanted: { first: number; last: number } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  // Writes: unconfirmed edits per row, cell errors from failed saves, and the rows as displayed.
  private pending = new Map<string, PendingEdit[]>();
  private saveErrors = new Map<string, Record<string, string>>();
  private display = new Map<string, DisplayRow>();
  private queue: PendingEdit[] = [];
  private inFlight = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private nextOpId = 1;

  query: RowQuery;
  /** Rows in the server's filtered result. */
  private serverTotal = 0;
  private totalKnown = false;
  /**
   * Rows added in this session that the server hasn't returned in a window yet. They're
   * shown after the server's rows (like Airtable keeps a new record at the bottom until
   * the view is reloaded) and leave this list once a window includes them.
   */
  private localRows: string[] = [];
  aggregates: Aggregates = {};
  /** Lives here (not in React state) so only rows whose part of it changes re-render. */
  selection: Selection | null = null;
  editing: EditingState | null = null;
  /** Latest message for the screen-reader live region; `announcementId` changes even if the text repeats. */
  announcement = "";
  announcementId = 0;

  constructor({ query, fields, fetchWindow, sendBatch, initialWindow }: GridStoreOptions) {
    this.query = query;
    this.fetchWindow = fetchWindow;
    this.sendBatch = sendBatch;
    this.formulas = buildFormulaContext(fields);
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

  // ---- reading rows ------------------------------------------------------------

  get total(): number {
    return this.serverTotal + this.localRows.length;
  }

  private isLocalIndex(index: number): boolean {
    return this.totalKnown && index >= this.serverTotal;
  }

  private rowIdAt(index: number): string | undefined {
    if (this.isLocalIndex(index)) return this.localRows[index - this.serverTotal];
    const block = this.blocks.get(Math.floor(index / BLOCK_SIZE));
    return block?.status === "ready" ? block.rowIds[index % BLOCK_SIZE] : undefined;
  }

  getRowAt(index: number): DisplayRow | undefined {
    const id = this.rowIdAt(index);
    return id === undefined ? undefined : (this.display.get(id) ?? this.rows.get(id));
  }

  getRowStatus(index: number): RowStatus {
    if (this.isLocalIndex(index)) return "ready";
    const block = this.blocks.get(Math.floor(index / BLOCK_SIZE));
    if (!block || block.status === "loading") return "loading";
    return block.status;
  }

  /** An arrow function so it can be handed to formatters without binding. */
  getLabel = (rowId: string): string | undefined => this.labels.get(rowId);

  /** Labels of records picked in the link editor, so the cell shows them before the server answers. */
  addLabels(labels: Record<string, string>): void {
    for (const [id, label] of Object.entries(labels)) this.labels.set(id, label);
  }

  get loadedBlockCount(): number {
    return this.blocks.size;
  }

  // ---- selection and editing ---------------------------------------------------

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

  /** "top:bottom" of the selected rows, or "" — what the toolbar's delete button acts on. */
  getSelectedRowsKey(): string {
    if (!this.selection) return "";
    const { top, bottom } = rangeOf(this.selection);
    return `${top}:${bottom}`;
  }

  startEditing(editing: EditingState): void {
    this.editing = editing;
    this.notify();
  }

  stopEditing(): void {
    if (!this.editing) return;
    this.editing = null;
    this.notify();
  }

  /** The column being edited in this row, or -1: a primitive, so only that row re-renders. */
  getEditingCol(row: number): number {
    return this.editing?.row === row ? this.editing.col : -1;
  }

  announce(message: string): void {
    this.announcement = message;
    this.announcementId++;
    this.notify();
  }

  // ---- writing -----------------------------------------------------------------

  /**
   * Applies changes immediately (optimistically) and queues them for the server.
   * Changes to the same row become one `update` op; everything written in the same
   * tick (a whole paste) goes out in one batch.
   */
  writeCells(changes: CellChange[]): void {
    const byRow = new Map<string, Record<string, CellValue>>();
    for (const { rowId, fieldId, value } of changes) {
      if (!byRow.has(rowId)) byRow.set(rowId, {});
      byRow.get(rowId)![fieldId] = value;
    }
    for (const [rowId, values] of byRow) {
      // A new attempt replaces the old error on those cells (before the row is rebuilt).
      const errors = this.saveErrors.get(rowId);
      if (errors) {
        for (const fieldId of Object.keys(values)) delete errors[fieldId];
        if (Object.keys(errors).length === 0) this.saveErrors.delete(rowId);
      }
      this.enqueue({ opId: this.nextOpId++, op: "update", rowId, values });
    }
    this.notify();
  }

  /** Adds an empty record at the bottom, optimistically, and returns its index. */
  addRow(values: Record<string, CellValue> = {}): number {
    const now = new Date().toISOString();
    const id = newId("row");
    // A client-generated id, so the row keeps its identity when the server confirms it.
    this.rows.set(id, { id, values, createdAt: now, updatedAt: now, rev: 0 });
    this.localRows.push(id);
    this.enqueue({ opId: this.nextOpId++, op: "create", rowId: id, values });
    this.notify();
    return this.total - 1;
  }

  /**
   * Deletes records. Not optimistic: the rows are shown as "deleting" until the server
   * confirms, then the windows are reloaded. Removing rows from the middle of loaded
   * blocks would shift every index after them, and deletion can't be undone in Core.
   */
  deleteRows(rowIds: string[]): void {
    for (const rowId of rowIds) this.enqueue({ opId: this.nextOpId++, op: "delete", rowId, values: {} });
    this.notify();
  }

  private enqueue(edit: PendingEdit) {
    this.pending.set(edit.rowId, [...(this.pending.get(edit.rowId) ?? []), edit]);
    this.queue.push(edit);
    this.refreshRow(edit.rowId);
    this.flushTimer ??= setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, 0);
  }

  /** Whether any edit is still waiting for the server. */
  get hasPendingWrites(): boolean {
    return this.queue.length > 0 || this.inFlight;
  }

  /**
   * Sends queued edits, one batch at a time. Sending sequentially keeps the server's
   * order equal to the user's order, so the last edit of a cell is the one that wins.
   */
  private async flush(): Promise<void> {
    if (this.inFlight || this.queue.length === 0) return;
    const batch = this.queue.splice(0, MAX_BATCH_OPS);
    this.inFlight = true;

    let results: RowOpResult[];
    try {
      results = await this.sendBatch(batch.map((edit) => this.toRowOp(edit)));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Network error";
      results = batch.map((edit) => ({ ok: false, rowId: edit.rowId, error: { code: "NETWORK", message: `Not saved: ${message}` } }));
    }
    this.inFlight = false;

    batch.forEach((edit, i) => this.settle(edit, results[i]));
    // Failed creates announce themselves in `settle`; this counts edits and deletes.
    const failed = batch.filter((edit, i) => edit.op !== "create" && !results[i]?.ok).length;
    if (failed > 0) this.announce(`${failed} ${failed === 1 ? "change" : "changes"} couldn't be saved`);
    // Deleted rows leave holes in the loaded windows: load them again.
    if (batch.some((edit, i) => edit.op === "delete" && results[i]?.ok)) this.reload();
    this.notify();
    if (this.queue.length > 0) void this.flush();
  }

  private toRowOp(edit: PendingEdit): RowOp {
    const rev = this.rows.get(edit.rowId)?.rev ?? 0;
    if (edit.op === "create") return { op: "create", rowId: edit.rowId, values: edit.values };
    if (edit.op === "delete") return { op: "delete", rowId: edit.rowId, rev };
    return { op: "update", rowId: edit.rowId, values: edit.values, rev };
  }

  /** Confirms or rolls back one edit. A rollback only drops this edit: other pending edits stay applied. */
  private settle(edit: PendingEdit, result: RowOpResult | undefined) {
    this.pending.set(edit.rowId, (this.pending.get(edit.rowId) ?? []).filter((candidate) => candidate !== edit));
    if (this.pending.get(edit.rowId)!.length === 0) this.pending.delete(edit.rowId);

    if (result?.ok) {
      if (result.row) this.rows.set(result.row.id, result.row);
      if (edit.op === "delete") this.forgetRow(edit.rowId);
    } else if (edit.op === "create") {
      // The record doesn't exist on the server, so it disappears (with any edits made to it meanwhile).
      this.forgetRow(edit.rowId);
      this.announce("Couldn't add the record");
      return;
    } else {
      const errors = { ...this.saveErrors.get(edit.rowId) };
      for (const fieldId of Object.keys(edit.values)) {
        errors[fieldId] = result?.error.fieldErrors?.[fieldId] ?? result?.error.message ?? "Not saved";
      }
      this.saveErrors.set(edit.rowId, errors);
    }
    this.refreshRow(edit.rowId);
  }

  private forgetRow(rowId: string) {
    this.rows.delete(rowId);
    this.display.delete(rowId);
    this.saveErrors.delete(rowId);
    this.localRows = this.localRows.filter((id) => id !== rowId);
  }

  private refreshRow(rowId: string) {
    const base = this.rows.get(rowId);
    const edits = this.pending.get(rowId) ?? [];
    const errors = this.saveErrors.get(rowId);
    if (!base || (edits.length === 0 && !errors)) this.display.delete(rowId);
    else this.display.set(rowId, displayRow(base, edits, errors, this.formulas, new Date()));
  }

  // ---- loading windows ---------------------------------------------------------

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
    this.display.clear();
    this.labels.clear();
    this.localRows = [];
    this.query = query;
    // Row positions mean something else in the new result, so the old selection would point at other rows.
    this.selection = null;
    this.editing = null;
    this.notify();
    this.loadWanted();
  }

  /**
   * Loads the current query's windows again (after deletes), keeping what's on screen
   * until the new data arrives. The selection is cleared: positions may have shifted.
   */
  reload(): void {
    this.generation++;
    this.abortAll();
    this.blocks.clear();
    this.selection = null;
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
    // Indexes past the server's rows belong to local rows: there's nothing to fetch for them.
    // Before the first answer the total is unknown, so nothing is clamped.
    const lastServerIndex = this.totalKnown ? Math.max(0, this.serverTotal - 1) : Infinity;
    const firstBlock = Math.floor(Math.min(Math.max(0, this.wanted.first), lastServerIndex) / BLOCK_SIZE);
    const lastBlock = Math.floor(Math.min(Math.max(0, this.wanted.last), lastServerIndex) / BLOCK_SIZE);

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
      if (block.status === "ready") {
        for (const id of block.rowIds) {
          // Rows with unsaved edits stay: their server answer still has to land somewhere.
          if (this.pending.has(id)) continue;
          this.rows.delete(id);
          this.display.delete(id);
          this.saveErrors.delete(id);
        }
      }
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
    for (const row of response.rows) {
      this.rows.set(row.id, row);
      // Re-apply edits still waiting for the server on top of the fresh row.
      if (this.pending.has(row.id) || this.saveErrors.has(row.id)) this.refreshRow(row.id);
    }
    for (const [id, label] of Object.entries(response.linkedLabels)) this.labels.set(id, label);
    this.blocks.set(blockIndex, { status: "ready", rowIds: response.rows.map((row) => row.id) });
    // A row added here is now part of the server's result: stop showing it separately.
    const returned = new Set(response.rows.map((row) => row.id));
    if (this.localRows.some((id) => returned.has(id))) this.localRows = this.localRows.filter((id) => !returned.has(id));
    this.serverTotal = response.total;
    this.totalKnown = true;
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
