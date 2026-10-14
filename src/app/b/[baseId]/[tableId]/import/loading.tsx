/** Suspense fallback while the import page checks the table and the user. */
export default function Loading() {
  return <div className="m-8 h-6 w-64 animate-pulse rounded bg-zinc-100 dark:bg-zinc-900" aria-busy="true" aria-label="Loading import" />;
}
