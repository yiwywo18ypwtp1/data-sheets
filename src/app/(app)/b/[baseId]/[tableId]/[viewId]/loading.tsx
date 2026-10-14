/** Suspense fallback for the view page: the shape of the shell, so the layout doesn't jump. */
export default function Loading() {
  return (
    <div className="flex flex-1 flex-col" aria-busy="true" aria-label="Loading table">
      <div className="h-10 bg-zinc-100 dark:bg-zinc-950" />
      <div className="h-11 border-b border-zinc-200 dark:border-zinc-800" />
      <div className="flex-1 animate-pulse space-y-2 p-4">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="h-6 rounded bg-zinc-100 dark:bg-zinc-900" />
        ))}
      </div>
    </div>
  );
}
