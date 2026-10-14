import { dismissToast, useToasts } from "./toastStore";

/** The corner messages (see toastStore.ts). A polite live region, so screen readers hear them too. */
export function Toasts() {
  const toasts = useToasts();
  return (
    <div role="status" aria-live="polite" className="pointer-events-none fixed right-4 bottom-12 z-50 flex w-96 flex-col gap-2">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`pointer-events-auto flex items-start gap-2 rounded-md border px-3 py-2 text-sm shadow-lg ${
            toast.tone === "warning" ? "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100" : "border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-900"
          }`}
        >
          <span className="flex-1">{toast.message}</span>
          {toast.action && (
            <button
              type="button"
              className="shrink-0 rounded bg-blue-600 px-2 py-0.5 text-white hover:bg-blue-700"
              onClick={() => {
                toast.action!.run();
                dismissToast(toast.id);
              }}
            >
              {toast.action.label}
            </button>
          )}
          <button type="button" aria-label="Dismiss" className="shrink-0 px-1 text-zinc-500" onClick={() => dismissToast(toast.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
