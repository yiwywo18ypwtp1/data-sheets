import { useEffect, useRef, type ReactNode } from "react";

/**
 * A modal on the native <dialog>: `showModal()` gives focus trapping, Escape to close,
 * an inert page behind it and the right ARIA semantics without extra code.
 * Events stop at the dialog, so keys typed here never reach the grid behind it.
 */
export function Dialog({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  return (
    <dialog
      ref={ref}
      aria-label={title}
      onClose={onClose}
      onKeyDown={(event) => event.stopPropagation()}
      onPaste={(event) => event.stopPropagation()}
      onCopy={(event) => event.stopPropagation()}
      className={`m-auto max-h-[85vh] w-full ${wide ? "max-w-2xl" : "max-w-md"} rounded-lg border border-zinc-200 bg-white p-0 text-zinc-900 shadow-xl backdrop:bg-black/30 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100`}
    >
      <div className="flex items-center border-b border-zinc-200 px-4 py-2.5 dark:border-zinc-800">
        <h2 className="font-semibold">{title}</h2>
        <button type="button" aria-label="Close" className="ml-auto rounded px-2 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="p-4">{children}</div>
    </dialog>
  );
}

export const labelClass = "flex flex-col gap-1 text-sm";
export const inputClass =
  "h-8 rounded border border-zinc-300 bg-white px-2 text-sm dark:border-zinc-700 dark:bg-zinc-950 aria-invalid:border-red-500 disabled:opacity-60";
export const primaryButtonClass = "rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-40";
export const secondaryButtonClass = "rounded px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800";
export const dangerButtonClass = "rounded bg-red-600 px-3 py-1.5 text-sm text-white hover:bg-red-700 disabled:opacity-40";

export function ErrorText({ children }: { children?: ReactNode }) {
  return children ? (
    <span role="alert" className="text-xs text-red-600">
      {children}
    </span>
  ) : null;
}
