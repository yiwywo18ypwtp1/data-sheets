import type { TextEncoding } from "@/lib/import/encoding";
import type { ColumnMapping } from "@/lib/import/mapping";

/**
 * An import in progress, saved in IndexedDB after each batch, so closing the tab (or a
 * crash) mid-import can be resumed: the file itself, the user's choices, and how far it
 * got. The server's idempotency keys make resuming safe even if the last batch reached
 * the server after the last save.
 */

export type ImportProgress = { nextRow: number; batchIndex: number; imported: number; skipped: number; emptied: number; rejected: number; createdRecords: number };
export type ReportLine = { row: number; outcome: "skipped" | "imported with empty values" | "rejected by the server"; column: string; value: string; problem: string };

export type ImportSession = {
  tableId: string;
  file: File;
  encoding: TextEncoding;
  delimiter: string;
  mapping: ColumnMapping[];
  strategy: "skip" | "empty";
  /** Values fixed in the check step: row → column → text. */
  overrides: [number, [number, string][]][];
  /** Link columns: whether missing records are created, and the ids given to created ones. */
  links: [string, { createMissing: boolean; created: [string, string][] }][];
  importId: string;
  progress: ImportProgress;
  report: ReportLine[];
  fieldsCreated: boolean;
  savedAt: string;
};

const DB_NAME = "data-sheets-import";
const STORE = "sessions";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "tableId" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function run<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = action(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

/** Storage can be unavailable (private mode, quota): an import still works, it just can't be resumed. */
export async function saveSession(session: ImportSession): Promise<void> {
  try {
    await run("readwrite", (store) => store.put(session));
  } catch {
    // not resumable, nothing else breaks
  }
}

export async function loadSession(tableId: string): Promise<ImportSession | null> {
  try {
    return ((await run("readonly", (store) => store.get(tableId))) as ImportSession | undefined) ?? null;
  } catch {
    return null;
  }
}

export async function clearSession(tableId: string): Promise<void> {
  try {
    await run("readwrite", (store) => store.delete(tableId));
  } catch {
    // nothing to clear
  }
}
