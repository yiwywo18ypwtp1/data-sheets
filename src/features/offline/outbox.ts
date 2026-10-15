import type { CellValue } from "@/lib/domain/cell";
import { idb, OUTBOX } from "./idb";

/**
 * Edits that haven't reached the server, kept in IndexedDB so they survive a reload, a
 * closed tab or a crash while offline. Each open grid owns one record (its queue as it is
 * now) and holds a Web Lock named after it for as long as it lives. A grid opening later
 * looks for records of its table whose lock is free, so their owner is gone: it takes
 * their edits over (deleting the record inside the lock, so two tabs can't both take
 * them) and sends them. A record whose owner is still open in another tab is left alone.
 * Records are also tied to the user they were made as: after the user is switched, the new
 * user's grid doesn't take them over (they'd be saved under the wrong name); they wait
 * for their own user to open the table again.
 */

export type OutboxEdit = {
  op: "create" | "update" | "delete";
  rowId: string;
  values: Record<string, CellValue>;
  /** The record's revision when the edit was made. */
  rev: number;
  restoreCreatedAt?: string;
};

export type OutboxRecord = { ownerId: string; /** The user the edits were made as. */ userId: string; tableId: string; edits: OutboxEdit[]; savedAt: string };

export type OutboxStorage = {
  put(record: OutboxRecord): Promise<void>;
  get(ownerId: string): Promise<OutboxRecord | undefined>;
  delete(ownerId: string): Promise<void>;
  listForTable(tableId: string): Promise<OutboxRecord[]>;
};

export type Locks = {
  /** Holds the lock until the returned function is called. Resolves once it's held. */
  hold(name: string): Promise<() => void>;
  /** Runs `task` holding the lock if nobody holds it now; null if somebody does. */
  ifFree<T>(name: string, task: () => Promise<T>): Promise<T | null>;
};

export const idbOutboxStorage: OutboxStorage = {
  put: async (record) => void (await idb(OUTBOX, "readwrite", (store) => store.put(record))),
  get: (ownerId) => idb(OUTBOX, "readonly", (store) => store.get(ownerId) as IDBRequest<OutboxRecord | undefined>),
  delete: async (ownerId) => void (await idb(OUTBOX, "readwrite", (store) => store.delete(ownerId))),
  listForTable: (tableId) => idb(OUTBOX, "readonly", (store) => store.index("tableId").getAll(tableId) as IDBRequest<OutboxRecord[]>),
};

/** Web Locks: released by the browser when the tab closes or crashes, which is exactly "the owner is gone". */
export const webLocks: Locks | null =
  typeof navigator !== "undefined" && "locks" in navigator
    ? {
        hold: (name) =>
          new Promise((resolve) => {
            void navigator.locks.request(name, () => new Promise<void>((release) => resolve(release)));
          }),
        ifFree: async (name, task) => (await navigator.locks.request(name, { ifAvailable: true }, (lock) => (lock ? task() : null))) as Awaited<ReturnType<typeof task>> | null,
      }
    : null;

const lockName = (ownerId: string) => `data-sheets-outbox:${ownerId}`;

/** Edits are written at most this often while a burst (a paste, its batches settling) goes on. */
const SAVE_DELAY_MS = 150;

export class Outbox {
  private release: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private latest: OutboxEdit[] | null = null;
  private saving: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(
    private readonly tableId: string,
    readonly ownerId: string,
    private readonly userId: string,
    private readonly storage: OutboxStorage = idbOutboxStorage,
    private readonly locks: Locks | null = webLocks,
  ) {}

  /** Takes this owner's lock: from now on other tabs know it's alive. */
  async start(): Promise<void> {
    const release = await this.locks?.hold(lockName(this.ownerId));
    if (this.disposed) release?.();
    else this.release = release ?? null;
  }

  /** The owner's queue changed: store it (soon; the newest state wins). An empty queue removes the record. */
  save(edits: OutboxEdit[]): void {
    if (this.disposed) return;
    this.latest = edits;
    this.timer ??= setTimeout(() => void this.flush(), SAVE_DELAY_MS);
  }

  /** Writes the pending state now. */
  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const edits = this.latest;
    this.latest = null;
    if (edits === null) return this.saving;
    // Writes go one after another, so an older state never lands after a newer one.
    this.saving = this.saving.then(() =>
      (edits.length === 0 ? this.storage.delete(this.ownerId) : this.storage.put({ ownerId: this.ownerId, userId: this.userId, tableId: this.tableId, edits, savedAt: new Date().toISOString() })).catch(() => undefined),
    );
    return this.saving;
  }

  /**
   * Edits left by owners that are gone (closed tabs, an earlier page load, a grid that
   * remounted), oldest record first. Without Web Locks there's no telling a closed tab
   * from an open one, so nothing is taken over.
   */
  async adoptOrphans(): Promise<OutboxEdit[]> {
    if (!this.locks) return [];
    let records: OutboxRecord[];
    try {
      records = await this.storage.listForTable(this.tableId);
    } catch {
      return [];
    }
    const adopted: OutboxEdit[] = [];
    for (const record of records.filter((candidate) => candidate.ownerId !== this.ownerId && candidate.userId === this.userId).sort((a, b) => a.savedAt.localeCompare(b.savedAt))) {
      const edits = await this.locks.ifFree(lockName(record.ownerId), async () => {
        // Read again inside the lock: another tab may have taken it over a moment ago.
        const current = await this.storage.get(record.ownerId);
        if (current?.userId !== this.userId) return [];
        await this.storage.delete(record.ownerId);
        return current.edits;
      });
      if (edits) adopted.push(...edits);
    }
    return adopted;
  }

  /** The grid closes: its last state is written, then the lock is let go (so a later grid may adopt it). */
  dispose(): void {
    this.disposed = true;
    void this.flush().finally(() => {
      this.release?.();
      this.release = null;
    });
  }
}
