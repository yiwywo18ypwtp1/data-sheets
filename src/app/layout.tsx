import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import { Suspense } from "react";
import { CurrentUserBadge } from "@/features/settings/CurrentUserBadge";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin", "cyrillic"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Data Sheets",
  description: "Simplified Airtable test task",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex h-full flex-col">
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
      </body>
    </html>
  );
}
