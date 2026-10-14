import { idb, idbTransaction, WINDOWS } from "./idb";

/**
 * Copies of what the server answered for row windows (the grid) and boards (kanban), so
 * a table opened offline still shows the rows it showed last time. Network first: the
 * copy is used only when the request fails without an answer (offline, a 5xx); an
 * answer from the server always wins and replaces the copy. The newest MAX_ENTRIES
 * answers are kept (a window of 100 rows is ~40 KB, so a few MB in all).
 */

const MAX_ENTRIES = 200;
const PRUNE_EVERY = 25;
let writes = 0;

type Entry<T> = { key: string; tableId: string; savedAt: number; value: T };

/** No answer at all, or a server error: worth falling back to a copy. A 4xx is a real "no". */
export function isUnreachable(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return false;
  const status = error && typeof error === "object" && "status" in error ? Number((error as { status: unknown }).status) : null;
  return status === null || status >= 500;
}

/** Deletes the oldest copies beyond MAX_ENTRIES, walking the time index from the oldest. */
function prune(): Promise<void> {
  return idbTransaction(WINDOWS, "readwrite", (store) => {
    const count = store.count();
    count.onsuccess = () => {
      let excess = count.result - MAX_ENTRIES;
      if (excess <= 0) return;
      const cursor = store.index("savedAt").openCursor();
      cursor.onsuccess = () => {
        if (!cursor.result || excess-- <= 0) return;
        cursor.result.delete();
        cursor.result.continue();
      };
    };
  });
}

/**
 * `load()`, remembering its answer under `key`; when it fails unreachable, the remembered
 * answer instead (`onCopy` tells the caller it's showing a copy). Storage errors never
 * fail the request.
 */
export async function withOfflineCopy<T>(tableId: string, key: string, load: () => Promise<T>, hooks: { onCopy?: (savedAt: Date) => void; onFresh?: () => void } = {}): Promise<T> {
  const fullKey = `${tableId}|${key}`;
  try {
    const value = await load();
    hooks.onFresh?.();
    const entry: Entry<T> = { key: fullKey, tableId, savedAt: Date.now(), value };
    void idb(WINDOWS, "readwrite", (store) => store.put(entry))
      .then(() => (++writes % PRUNE_EVERY === 0 ? prune() : undefined))
      .catch(() => undefined);
    return value;
  } catch (error) {
    if (!isUnreachable(error)) throw error;
    const entry = await idb(WINDOWS, "readonly", (store) => store.get(fullKey) as IDBRequest<Entry<T> | undefined>).catch(() => undefined);
    if (!entry) throw error;
    hooks.onCopy?.(new Date(entry.savedAt));
    return entry.value;
  }
}
