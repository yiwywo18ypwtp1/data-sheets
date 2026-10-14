"use client";

import { useEffect } from "react";

/**
 * Last-resort boundary for the view page. Recoverable problems (a failed row window,
 * a rejected edit) are handled inside the grid and never reach this.
 */
export default function ViewError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div role="alert" className="m-8 max-w-md space-y-3">
      <h2 className="text-lg font-semibold">This table couldn&apos;t be loaded</h2>
      <p className="text-sm text-zinc-500">Something went wrong on our side. Your saved data is not affected.</p>
      <button type="button" onClick={retry} className="rounded bg-zinc-900 px-3 py-1.5 text-sm text-white dark:bg-zinc-100 dark:text-zinc-900">
        Try again
      </button>
    </div>
  );
}
