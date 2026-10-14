import Link from "next/link";
import { Suspense } from "react";
import { CurrentUserBadge } from "@/features/settings/CurrentUserBadge";

/** The app's frame (bases, settings). Public forms (`/f/…`) are outside it: guests see no app chrome. */
export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <>
      <header className="flex h-12 shrink-0 items-center gap-4 border-b border-zinc-200 px-4 dark:border-zinc-800">
        <Link href="/" className="font-semibold">
          Data Sheets
        </Link>
        <div className="ml-auto">
          {/* Reads the user cookie, so it streams in; the rest of the header is static. */}
          <Suspense fallback={<span className="text-sm text-zinc-400">…</span>}>
            <CurrentUserBadge />
          </Suspense>
        </div>
      </header>
      <main className="flex min-h-0 flex-1 flex-col">{children}</main>
    </>
  );
}
