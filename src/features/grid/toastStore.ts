import { useSyncExternalStore } from "react";

/**
 * Short messages in the corner: realtime notices ("Eddie deleted the record you were
 * editing") and conflicts with a "Keep mine" action. Module-level rather than in the
 * grid store, because some must survive the grid remounting after a schema change.
 */
export type Toast = { id: number; message: string; action?: { label: string; run: () => void }; tone?: "info" | "warning" };

const DEFAULT_TTL_MS = 8000;
let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

/** Shows a toast; one with an action stays longer, so there's time to use it. */
export function pushToast(toast: Omit<Toast, "id">, ttlMs = toast.action ? 30_000 : DEFAULT_TTL_MS): number {
  const id = nextId++;
  toasts = [...toasts.slice(-4), { ...toast, id }];
  notify();
  setTimeout(() => dismissToast(id), ttlMs);
  return id;
}

export function dismissToast(id: number): void {
  if (!toasts.some((toast) => toast.id === id)) return;
  toasts = toasts.filter((toast) => toast.id !== id);
  notify();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const empty: Toast[] = [];

export function useToasts(): Toast[] {
  return useSyncExternalStore(subscribe, () => toasts, () => empty);
}
