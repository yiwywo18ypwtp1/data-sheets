import { useSyncExternalStore } from "react";
import type { GridStore } from "./GridStore";

/**
 * Subscribes a component to one slice of the grid store. The selector must return
 * a primitive or an object the store keeps stable (a row, the aggregates), never
 * a freshly built object, or the component would re-render on every store change.
 */
export function useGridStore<T>(store: GridStore, select: (store: GridStore) => T): T {
  return useSyncExternalStore(
    store.subscribe,
    () => select(store),
    () => select(store),
  );
}
