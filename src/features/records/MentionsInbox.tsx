"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { commentText, type Mention } from "@/lib/domain/comment";
import { routes } from "@/lib/routes";
import { useOutsidePointerDown } from "@/features/grid/editors/useOutsidePointerDown";
import { fetchMentions, fetchUsers, markMentionsRead, type UserOption } from "./api";
import { onMentionsChanged } from "./mentions";

const POLL_MS = 30_000;

/**
 * "@" in the app header: comments that mention the current user, in any table, with
 * the unread count. Polled (and reloaded when a mention arrives on the open table's
 * stream); opening an entry goes to its record with the comments open.
 */
export function MentionsInbox() {
  const router = useRouter();
  const [data, setData] = useState<{ mentions: Mention[]; unread: number } | null>(null);
  const [users, setUsers] = useState<UserOption[]>([]);
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  useOutsidePointerDown([buttonRef, panelRef], () => setOpen(false));

  useEffect(() => {
    const load = () => fetchMentions().then(setData, () => undefined);
    load();
    const timer = setInterval(load, POLL_MS);
    const off = onMentionsChanged(load);
    window.addEventListener("focus", load);
    return () => {
      clearInterval(timer);
      off();
      window.removeEventListener("focus", load);
    };
  }, []);
  useEffect(() => {
    if (open) fetchUsers().then(setUsers, () => undefined);
  }, [open]);

  const nameOf = (id: string) => users.find((user) => user.id === id)?.name;
  const unread = data?.unread ?? 0;

  function go(mention: Mention) {
    setOpen(false);
    if (!mention.read) {
      setData((current) => current && { unread: Math.max(0, current.unread - 1), mentions: current.mentions.map((item) => (item.commentId === mention.commentId ? { ...item, read: true } : item)) });
      markMentionsRead([mention.commentId]).catch(() => undefined);
    }
    router.push(`${routes.view(mention.baseId, mention.tableId, mention.viewId)}?record=${mention.rowId}`);
  }

  return (
    <span className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={unread > 0 ? `Mentions, ${unread} unread` : "Mentions"}
        className="relative rounded px-2 py-1 text-sm text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
        onClick={() => setOpen((value) => !value)}
      >
        @
        {unread > 0 && <span className="absolute -top-1 -right-1 min-w-4 rounded-full bg-red-600 px-1 text-[10px] leading-4 font-semibold text-white">{unread > 99 ? "99+" : unread}</span>}
      </button>
      {open && (
        <div ref={panelRef} role="dialog" aria-label="Mentions" className="absolute top-full right-0 z-50 mt-1 flex max-h-96 w-80 flex-col rounded-md border border-zinc-200 bg-white text-sm shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
          <div className="flex items-center border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
            <span className="font-medium">Mentions</span>
            {unread > 0 && (
              <button
                type="button"
                className="ml-auto text-xs text-blue-600 hover:underline"
                onClick={() => {
                  setData((current) => current && { unread: 0, mentions: current.mentions.map((item) => ({ ...item, read: true })) });
                  markMentionsRead().catch(() => undefined);
                }}
              >
                Mark all read
              </button>
            )}
          </div>
          {data?.mentions.length === 0 && <p className="px-3 py-4 text-sm text-zinc-500">Nobody has mentioned you yet.</p>}
          <ul className="overflow-auto">
            {data?.mentions.map((mention) => (
              <li key={mention.commentId}>
                <button type="button" className="block w-full px-3 py-2 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800" onClick={() => go(mention)}>
                  <span className="flex items-center gap-1.5 text-xs text-zinc-500">
                    {!mention.read && <span aria-label="unread" className="size-1.5 rounded-full bg-blue-600" />}
                    <span className="font-medium text-zinc-700 dark:text-zinc-200">{mention.by}</span>
                    in {mention.tableName} · {mention.recordLabel || "a deleted record"}
                  </span>
                  <span className="mt-0.5 line-clamp-2 text-sm">{commentText(mention.body, nameOf)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </span>
  );
}
