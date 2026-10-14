import type { Aggregates, RowGroup, RowWindowResponse } from "@/lib/domain/api";
import type { CellValue } from "@/lib/domain/cell";
import { isComputedField, type Field } from "@/lib/domain/field";
import { usesRelativeDates } from "@/lib/domain/filter";
import { newId } from "@/lib/domain/ids";
import { MAX_BATCH_OPS, type Row, type RowOp, type RowOpResult } from "@/lib/domain/row";
import type { RowQuery } from "./api";
import { History, type DeletedRow, type HistoryChange, type HistoryEntry } from "./history";
import { GroupLayout } from "./groupLayout";
import { buildFormulaContext, displayRow, type DisplayRow, type FormulaContext, type PendingEdit } from "./optimistic";
import type { PresenceEntry, RowChange } from "./realtime";
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
/** Remote row additions and deletions are coalesced this long before the windows are refetched. */
export const REFRESH_DELAY_MS = 150;

/** Another user's write overwrote this tab's value of a cell. */
export type Conflict = { rowId: string; fieldId: string; mine: CellValue; theirs: CellValue; by: string };

/** A failure worth retrying: no answer at all, or a server error (5xx). A 4xx is the server saying no. */
function isTransient(error: unknown): boolean {
  const status = error && typeof error === "object" && "status" in error ? Number((error as { status: unknown }).status) : null;
  return status === null || status >= 500;
}

export type FetchWindow = (query: RowQuery, offset: number, limit: number, signal: AbortSignal, withGroups?: boolean) => Promise<RowWindowResponse>;
export type SendBatch = (ops: RowOp[]) => Promise<RowOpResult[]>;

type Block =
  | { status: "loading"; controller: AbortController }
  | { status: "ready"; rowIds: string[] }
  | { status: "error"; message: string };

export type RowStatus = "ready" | "loading" | "error";
export type CellChange = { rowId: string; fieldId: string; value: CellValue };
export type CellError = { rowId: string; fieldId: string; message: string };
/** What to do with a paste that runs past the last row. */
export type PasteChoice = "add" | "fit" | "cancel";
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
  private readonly history = new History();
  /**
   * The value and row revision of this tab's last confirmed write per cell. A remote change
   * of the same cell with a newer revision means someone else's write won: a conflict.
   */
  private confirmed = new Map<string, { value: CellValue; rev: number; at: number }>();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelay = 0;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  /** The grouped view's groups (null: not grouped, or not loaded yet), and which are collapsed. */
  private groups: RowGroup[] | null = null;
  /** The rows changed: the groups are asked for again with the next window, the old ones stay shown meanwhile. */
  private groupsStale = false;
  private collapsed = new Set<string>();
  private layoutCache: { key: string; layout: GroupLayout } | null = null;
  private groupsVersion = 0;
  /** Other tabs' selected cells, by row id. */
  private presenceByRow = new Map<string, { fieldId: string; color: string; name: string }[]>();

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
  /** Whether writes reach the server; "offline" while a failed batch waits to be sent again. */
  connection: "online" | "offline" = "online";
  /** Other people on this table (one entry per user), for the avatars. */
  others: PresenceEntry[] = [];
  /** A paste waiting for the user to decide about extra rows (shown by the toolbar). */
  pastePrompt: { extraRows: number; answer: (choice: PasteChoice) => void } | null = null;

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

  /** What's on screen, row by row: group headers and rows (see groupLayout.ts). A stable object until it changes. */
  get layout(): GroupLayout {
    const key = `${this.groupsVersion}:${this.total}:${[...this.collapsed].join("|")}`;
    if (this.layoutCache?.key !== key) {
      const grouped = (this.query.groupBy?.length ?? 0) > 0 ? this.groups : null;
      this.layoutCache = { key, layout: new GroupLayout(grouped, this.total, this.collapsed) };
    }
    return this.layoutCache.layout;
  }

  toggleGroup(path: string): void {
    if (!this.collapsed.delete(path)) this.collapsed.add(path);
    this.notify();
  }

  /** Expands the groups around a row (keyboard navigation or undo went into a collapsed group). */
  revealRow(index: number): boolean {
    const hidden = this.layout.pathsContaining(index).filter((path) => this.collapsed.has(path));
    if (hidden.length === 0) return false;
    for (const path of hidden) this.collapsed.delete(path);
    this.notify();
    return true;
  }

  private get wantsGroups(): boolean {
    return (this.query.groupBy?.length ?? 0) > 0 && (this.groups === null || this.groupsStale);
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

  /** Applies a user action and records it, so one Cmd+Z undoes all of it (a whole paste included). */
  applyChanges(label: string, changes: HistoryChange[]): void {
    if (changes.length === 0) return;
    this.writeCells(changes.map(({ rowId, fieldId, after }) => ({ rowId, fieldId, value: after })));
    this.history.push({ label, changes });
  }

  /** Writes the `before` values of the last action back. Returns it, so the grid can show where it happened. */
  undo(): HistoryEntry | null {
    const entry = this.history.undo();
    if (!entry) return null;
    if (entry.deletedRows) this.restoreRows(entry.deletedRows);
    this.writeCells(entry.changes.map(({ rowId, fieldId, before }) => ({ rowId, fieldId, value: before })));
    this.announce(`Undid ${entry.label}`);
    return entry;
  }

  redo(): HistoryEntry | null {
    const entry = this.history.redo();
    if (!entry) return null;
    if (entry.deletedRows) this.sendDeletes(entry.deletedRows.map((row) => row.id));
    this.writeCells(entry.changes.map(({ rowId, fieldId, after }) => ({ rowId, fieldId, value: after })));
    this.announce(`Redid ${entry.label}`);
    return entry;
  }

  /** Marks cells whose pasted text couldn't be converted (they keep their value and get a red frame). */
  setCellErrors(errors: CellError[]): void {
    for (const { rowId, fieldId, message } of errors) {
      this.saveErrors.set(rowId, { ...this.saveErrors.get(rowId), [fieldId]: message });
      this.refreshRow(rowId);
    }
    this.notify();
  }

  /** Asks (through the toolbar) whether to add rows for a paste that runs past the end. */
  askAboutExtraRows(extraRows: number): Promise<PasteChoice> {
    return new Promise((resolve) => {
      this.pastePrompt = {
        extraRows,
        answer: (choice) => {
          this.pastePrompt = null;
          this.notify();
          resolve(choice);
        },
      };
      this.notify();
    });
  }

  /**
   * Rows `first..last` of the current result, in order: the loaded ones from memory, the
   * rest fetched in pages of 500 without keeping them (a paste over 10 000 rows must not
   * blow the memory budget). Throws if the view's query changes meanwhile.
   */
  async getRowsInRange(first: number, last: number): Promise<DisplayRow[]> {
    const generation = this.generation;
    const rows: DisplayRow[] = [];
    let index = first;
    while (index <= last) {
      const loaded = this.getRowAt(index);
      if (loaded) {
        rows.push(loaded);
        index++;
        continue;
      }
      const limit = Math.min(500, last - index + 1);
      const response = await this.fetchWindow(this.query, index, limit, new AbortController().signal);
      if (generation !== this.generation) throw new Error("The view changed while the rows were loading");
      for (const [id, label] of Object.entries(response.linkedLabels)) this.labels.set(id, label);
      if (response.rows.length === 0) break;
      for (const row of response.rows) rows.push(this.display.get(row.id) ?? row);
      index += response.rows.length;
    }
    return rows;
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
   * confirms, then the windows are reloaded (removing rows from the middle of loaded
   * blocks would shift every index after them). The records' values are kept in the
   * history, so Cmd+Z creates them again.
   */
  deleteRows(rowIds: string[]): void {
    const deletedRows: DeletedRow[] = rowIds.flatMap((id) => {
      const row = this.display.get(id) ?? this.rows.get(id);
      if (!row) return [];
      // Computed cells are recomputed by the server; only what was typed is restored.
      const values = Object.fromEntries(Object.entries(row.values).filter(([fieldId]) => !this.formulas.fieldsById.get(fieldId) || !isComputedField(this.formulas.fieldsById.get(fieldId)!)));
      return [{ id, values, createdAt: row.createdAt }];
    });
    this.history.push({ label: `deletion of ${rowIds.length} ${rowIds.length === 1 ? "record" : "records"}`, changes: [], deletedRows });
    this.sendDeletes(rowIds);
  }

  private sendDeletes(rowIds: string[]) {
    for (const rowId of rowIds) this.enqueue({ opId: this.nextOpId++, op: "delete", rowId, values: {} });
    this.notify();
  }

  /** Undo of a deletion: the same records, with the same ids, back in their place. */
  private restoreRows(rows: DeletedRow[]) {
    for (const row of rows) this.enqueue({ opId: this.nextOpId++, op: "create", rowId: row.id, values: row.values, restoreCreatedAt: row.createdAt });
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
      this.inFlight = false;
      if (isTransient(error)) return this.waitAndResend(batch);
      const message = error instanceof Error ? error.message : "Request failed";
      results = batch.map((edit) => ({ ok: false, rowId: edit.rowId, error: { code: "REQUEST_FAILED", message: `Not saved: ${message}` } }));
    }
    this.inFlight = false;
    if (this.connection === "offline") {
      this.connection = "online";
      this.retryDelay = 0;
      this.announce("Back online: waiting changes were saved");
    }

    batch.forEach((edit, i) => this.settle(edit, results[i]));
    // Failed creates announce themselves in `settle`; this counts edits and deletes.
    const failed = batch.filter((edit, i) => edit.op !== "create" && !results[i]?.ok).length;
    if (failed > 0) this.announce(`${failed} ${failed === 1 ? "change" : "changes"} couldn't be saved`);
    // Deleted rows leave holes in the loaded windows, restored ones need their place: load them again.
    if (batch.some((edit, i) => (edit.op === "delete" || edit.restoreCreatedAt) && results[i]?.ok)) this.reload();
    this.notify();
    if (this.queue.length > 0) void this.flush();
  }

  /**
   * The batch didn't reach the server (offline, a 5xx): its edits stay applied and queued,
   * in front of anything edited since, and are sent again with growing pauses. Nothing
   * is rolled back for a network problem; only the server rejecting an edit rolls it back.
   */
  private waitAndResend(batch: PendingEdit[]) {
    this.queue.unshift(...batch);
    if (this.connection === "online") this.announce("Connection lost: changes are kept and will be sent when it's back");
    this.connection = "offline";
    this.retryDelay = Math.min(30_000, Math.max(1000, this.retryDelay * 2));
    this.retryTimer = setTimeout(() => this.resendNow(), this.retryDelay);
    this.notify();
  }

  /** Sends waiting edits at once (the browser reports it's online again). */
  resendNow(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    void this.flush();
  }

  /** Edits not yet confirmed by the server, for the connection indicator. */
  get unsentCount(): number {
    return this.queue.length;
  }

  private toRowOp(edit: PendingEdit): RowOp {
    const rev = this.rows.get(edit.rowId)?.rev ?? 0;
    if (edit.op === "create") return { op: "create", rowId: edit.rowId, values: edit.values, ...(edit.restoreCreatedAt ? { createdAt: edit.restoreCreatedAt } : {}) };
    if (edit.op === "delete") return { op: "delete", rowId: edit.rowId, rev };
    return { op: "update", rowId: edit.rowId, values: edit.values, rev };
  }

  /** Confirms or rolls back one edit. A rollback only drops this edit: other pending edits stay applied. */
  private settle(edit: PendingEdit, result: RowOpResult | undefined) {
    this.pending.set(edit.rowId, (this.pending.get(edit.rowId) ?? []).filter((candidate) => candidate !== edit));
    if (this.pending.get(edit.rowId)!.length === 0) this.pending.delete(edit.rowId);

    if (result?.ok) {
      // Only rows the grid holds are updated: a paste into 10 000 unloaded rows must not keep them all.
      if (result.row && this.rows.has(result.row.id)) this.rows.set(result.row.id, result.row);
      if (edit.op === "update" && result.row) {
        for (const [fieldId, value] of Object.entries(edit.values)) this.confirmed.set(`${edit.rowId}:${fieldId}`, { value, rev: result.row.rev, at: Date.now() });
      }
      if (edit.op === "delete") this.forgetRow(edit.rowId);
    } else if (edit.op === "create" && edit.restoreCreatedAt) {
      this.announce("Couldn't restore a deleted record");
      return;
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

  // ---- changes from other users -------------------------------------------------

  /**
   * Applies another tab's row changes. Loaded rows are replaced in place (edits still
   * waiting here are re-applied on top, so they aren't lost); rows that were added or
   * deleted shift positions, so the loaded windows are fetched again in the background.
   * Returns what the grid has to tell the user about.
   */
  applyRemoteRows(changes: RowChange[], deleted: string[], by: string): { conflicts: Conflict[]; deletedWhileEditing: boolean } {
    const conflicts: Conflict[] = [];
    let structural = deleted.length > 0;
    for (const { row, fields, created } of changes) {
      if (created) structural = true;
      for (const fieldId of fields) {
        const key = `${row.id}:${fieldId}`;
        const mine = this.confirmed.get(key);
        if (!mine || row.rev <= mine.rev) continue;
        this.confirmed.delete(key);
        const theirs = row.values[fieldId] ?? null;
        if (JSON.stringify(theirs) !== JSON.stringify(mine.value)) conflicts.push({ rowId: row.id, fieldId, mine: mine.value, theirs, by });
      }
      const current = this.rows.get(row.id);
      // An older revision than the one held (events and batch answers can cross): keep the newer.
      if (current && current.rev < row.rev) {
        this.rows.set(row.id, row);
        this.refreshRow(row.id);
      }
    }

    const editingRowId = this.editing ? this.rowIdAt(this.editing.row) : undefined;
    const deletedWhileEditing = editingRowId !== undefined && deleted.includes(editingRowId);
    if (deletedWhileEditing) this.editing = null;
    for (const rowId of deleted) {
      if (!this.pending.has(rowId)) this.forgetRow(rowId);
    }
    if (structural) this.refresh();
    this.notify();
    return { conflicts, deletedWhileEditing };
  }

  /**
   * Fetches the loaded windows again without dropping what's on screen or the selection:
   * rows other people added or deleted moved everything after them. Bursts (an import
   * running elsewhere) are coalesced.
   */
  refresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.groupsStale = true;
      const generation = this.generation;
      for (const [index, block] of this.blocks) {
        if (block.status !== "ready") continue;
        this.fetchWindow(this.query, index * BLOCK_SIZE, BLOCK_SIZE, new AbortController().signal, this.wantsGroups).then(
          (response) => {
            if (generation !== this.generation || this.blocks.get(index)?.status !== "ready") return;
            this.applyWindow(index, response);
            this.notify();
          },
          () => undefined,
        );
      }
    }, REFRESH_DELAY_MS);
  }

  /** Other tabs' presence (this tab's own entry excluded by the caller). */
  setPresence(entries: PresenceEntry[]): void {
    this.presenceByRow.clear();
    for (const entry of entries) {
      if (!entry.cell) continue;
      const list = this.presenceByRow.get(entry.cell.rowId) ?? [];
      list.push({ fieldId: entry.cell.fieldId, color: entry.color, name: entry.name });
      this.presenceByRow.set(entry.cell.rowId, list);
    }
    const byUser = new Map(entries.map((entry) => [entry.userId, entry]));
    this.others = [...byUser.values()];
    this.notify();
  }

  /** "fieldId|color|name;…" for one row: a primitive, so only rows whose presence changes re-render. */
  getPresenceKey(rowId: string | undefined): string {
    const list = rowId ? this.presenceByRow.get(rowId) : undefined;
    return list ? list.map((entry) => `${entry.fieldId}|${entry.color}|${entry.name}`).join(";") : "";
  }

  /** The row id and field index of the active cell, for this tab's own presence. */
  activeRowId(): string | undefined {
    return this.selection ? this.rowIdAt(this.selection.anchor.row) : undefined;
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
    this.groups = null;
    this.groupsVersion++;
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
    this.groupsStale = true;
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
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
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
      const response = await this.fetchWindow(this.query, index * BLOCK_SIZE, BLOCK_SIZE, controller.signal, this.wantsGroups);
      if (!isCurrent()) return;
      this.applyWindow(index, response);
    } catch (error) {
      if (!isCurrent()) return;
      this.blocks.set(index, { status: "error", message: error instanceof Error ? error.message : "Failed to load rows" });
    }
    this.notify();
  }

  private applyWindow(blockIndex: number, response: RowWindowResponse) {
    if (response.groups) {
      this.groups = response.groups;
      this.groupsStale = false;
      this.groupsVersion++;
    }
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
