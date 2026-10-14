/**
 * The offline database: unsent edits per tab (`outbox`) and copies of loaded row windows
 * (`windows`). Every call opens, does one request and closes, like the import session:
 * these are rare, small operations, and a held connection would block version upgrades
 * from another tab. Storage can be unavailable (private mode, quota, tests without
 * IndexedDB); callers treat a failure as "not stored", nothing else breaks.
 */

const DB_NAME = "data-sheets-offline";
const VERSION = 1;
export const OUTBOX = "outbox";
export const WINDOWS = "windows";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("IndexedDB is not available"));
    const request = indexedDB.open(DB_NAME, VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore(OUTBOX, { keyPath: "ownerId" }).createIndex("tableId", "tableId");
      const windows = db.createObjectStore(WINDOWS, { keyPath: "key" });
      windows.createIndex("tableId", "tableId");
      windows.createIndex("savedAt", "savedAt");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Runs one request in its own transaction and resolves when the transaction has committed. */
export async function idb<T>(store: string, mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  let request: IDBRequest<T> | undefined;
  await idbTransaction(store, mode, (objectStore) => {
    request = action(objectStore);
  });
  return request!.result;
}

/** Runs `work` (any number of requests, cursors) in one transaction; resolves when it has committed. */
export async function idbTransaction(store: string, mode: IDBTransactionMode, work: (store: IDBObjectStore) => void): Promise<void> {
  const db = await open();
  try {
    return await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(store, mode);
      work(transaction.objectStore(store));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}
