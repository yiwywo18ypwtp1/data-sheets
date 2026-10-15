"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { commentInputSchema, commentSegments, mentionQueryAt, toStoredBody, type Comment, type CommentInput } from "@/lib/domain/comment";
import { ApiRequestError } from "@/features/grid/api";
import { deleteComment, fetchComments, fetchUsers, postComment, type UserOption } from "./api";
import { onCommentEvent } from "./commentBus";

type CommentsProps = {
  tableId: string;
  rowId: string;
  currentUserId: string;
  locale: string;
  timeZone: string;
};

/** A record's comments, kept current by the table's realtime stream, and the composer. */
export function Comments({ tableId, rowId, currentUserId, locale, timeZone }: CommentsProps) {
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [users, setUsers] = useState<UserOption[]>([]);

  useEffect(() => {
    fetchUsers().then(setUsers, () => undefined);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetchComments(tableId, rowId, controller.signal).then(
      (response) => {
        setComments(response.comments);
        setError(null);
      },
      (cause: unknown) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Couldn't load the comments");
      },
    );
    // Other people's comments arrive on the stream (this tab's own are added when posted).
    const off = onCommentEvent((event) => {
      if (event.rowId !== rowId) return;
      setComments((current) => {
        if (!current) return current;
        if (event.deletedId) return current.filter((comment) => comment.id !== event.deletedId);
        const added = event.comment;
        return added && !current.some((comment) => comment.id === added.id) ? [...current, added] : current;
      });
    });
    return () => {
      controller.abort();
      off();
    };
  }, [tableId, rowId]);

  const names = useMemo(() => new Map(users.map((user) => [user.id, user.name])), [users]);
  const when = useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone }), [locale, timeZone]);
  const listRef = useRef<HTMLOListElement>(null);
  // New comments appear at the bottom: keep the newest in view.
  useEffect(() => {
    listRef.current?.lastElementChild?.scrollIntoView({ block: "nearest" });
  }, [comments?.length]);

  async function remove(comment: Comment) {
    try {
      await deleteComment(tableId, comment.id);
      setComments((current) => current?.filter((candidate) => candidate.id !== comment.id) ?? null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't delete the comment");
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      {comments === null && !error && <p className="text-sm text-zinc-400">Loading…</p>}
      {comments?.length === 0 && <p className="text-sm text-zinc-500">No comments yet. Type @ to mention someone.</p>}
      <ol ref={listRef} aria-label="Comments" className="flex flex-col gap-2">
        {comments?.map((comment) => (
          <li key={comment.id} className="group/comment rounded bg-zinc-50 px-3 py-2 text-sm dark:bg-zinc-900">
            <div className="flex items-baseline gap-2 text-xs text-zinc-500">
              <span className="font-medium text-zinc-700 dark:text-zinc-200">{comment.author.name}</span>
              <time dateTime={comment.createdAt}>{when.format(new Date(comment.createdAt))}</time>
              {comment.author.userId === currentUserId && (
                <button type="button" className="ml-auto hidden text-zinc-400 group-hover/comment:inline hover:text-red-600 focus:inline" onClick={() => void remove(comment)}>
                  Delete
                </button>
              )}
            </div>
            <p className="mt-1 break-words whitespace-pre-wrap">
              {commentSegments(comment.body).map((segment, i) =>
                segment.kind === "text" ? (
                  segment.text
                ) : (
                  <span
                    key={i}
                    className={`rounded px-0.5 font-medium ${segment.userId === currentUserId ? "bg-amber-100 text-amber-900 dark:bg-amber-900/50 dark:text-amber-200" : "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300"}`}
                  >
                    @{names.get(segment.userId) ?? "unknown user"}
                  </span>
                ),
              )}
            </p>
          </li>
        ))}
      </ol>
      <Composer
        users={users}
        onSubmit={async (body) => {
          const { comment } = await postComment(tableId, rowId, body);
          setComments((current) => (current && !current.some((candidate) => candidate.id === comment.id) ? [...current, comment] : current));
        }}
      />
    </div>
  );
}

/**
 * React Hook Form over the comment text, checked with the same schema as the server.
 * Typing "@" opens a list of people; picking one inserts their name, and on submit the
 * picked names become mention tokens (see `toStoredBody`).
 */
function Composer({ users, onSubmit }: { users: UserOption[]; onSubmit: (body: string) => Promise<void> }) {
  const form = useForm<CommentInput>({ resolver: zodResolver(commentInputSchema), defaultValues: { body: "" } });
  const { ref: registerRef, ...field } = form.register("body");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [picked, setPicked] = useState<UserOption[]>([]);
  const [query, setQuery] = useState<{ start: number; query: string } | null>(null);
  const [active, setActive] = useState(0);
  const listId = useId();
  const errors = form.formState.errors;

  const matches = query ? users.filter((user) => user.name.toLowerCase().includes(query.query.toLowerCase())).slice(0, 6) : [];
  const updateQuery = () => {
    const element = textareaRef.current;
    setQuery(element ? mentionQueryAt(element.value, element.selectionStart) : null);
    setActive(0);
  };

  function pick(user: UserOption) {
    const element = textareaRef.current;
    if (!element || !query) return;
    const caret = element.selectionStart;
    const text = `${element.value.slice(0, query.start)}@${user.name} ${element.value.slice(caret)}`;
    // The caret is placed in the same task as the text: typing right after picking (or a fast
    // typist) must land after the name, not before it when a later frame moves the caret.
    const position = query.start + user.name.length + 2;
    element.value = text;
    element.setSelectionRange(position, position);
    form.setValue("body", text, { shouldDirty: true });
    setPicked((current) => [...current, user]);
    setQuery(null);
  }

  const submit = form.handleSubmit(async ({ body }) => {
    try {
      await onSubmit(toStoredBody(body, picked));
      form.reset({ body: "" });
      setPicked([]);
    } catch (cause) {
      const message = cause instanceof ApiRequestError ? (cause.fieldErrors?.body ?? cause.message) : "Couldn't post the comment";
      form.setError("body", { message });
    }
  });

  return (
    <form aria-label="Add a comment" className="sticky bottom-0 flex flex-col gap-1.5 bg-white pt-1 dark:bg-zinc-950" onSubmit={(event) => void submit(event)}>
      <textarea
        {...field}
        ref={(element) => {
          registerRef(element);
          textareaRef.current = element;
        }}
        rows={3}
        placeholder="Add a comment… (@ to mention, ⌘↵ to send)"
        aria-invalid={errors.body ? true : undefined}
        aria-autocomplete="list"
        aria-controls={matches.length > 0 ? listId : undefined}
        aria-activedescendant={matches.length > 0 ? `${listId}-${active}` : undefined}
        className="w-full resize-y rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        onChange={(event) => {
          void field.onChange(event);
          updateQuery();
        }}
        onClick={updateQuery}
        onKeyDown={(event) => {
          if (matches.length > 0) {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setActive((index) => (index + (event.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
              return;
            }
            if (event.key === "Enter" || event.key === "Tab") {
              event.preventDefault();
              return pick(matches[active]);
            }
            if (event.key === "Escape") {
              // Closes the list, not the record panel.
              event.preventDefault();
              return setQuery(null);
            }
          }
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void submit();
          }
        }}
      />
      {matches.length > 0 && (
        <ul id={listId} role="listbox" aria-label="People" className="absolute bottom-full left-0 mb-1 w-60 rounded-md border border-zinc-200 bg-white py-1 text-sm shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
          {matches.map((user, i) => (
            <li
              key={user.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={`cursor-pointer px-3 py-1 ${i === active ? "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300" : ""}`}
              // pointerdown, not click: the textarea must keep focus (and its caret).
              onPointerDown={(event) => {
                event.preventDefault();
                pick(user);
              }}
            >
              {user.name}
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-2">
        {errors.body && (
          <span role="alert" className="text-xs text-red-600">
            {errors.body.message}
          </span>
        )}
        <button type="submit" disabled={form.formState.isSubmitting} className="ml-auto rounded bg-blue-600 px-2.5 py-1 text-sm text-white hover:bg-blue-700 disabled:opacity-40">
          {form.formState.isSubmitting ? "Sending…" : "Comment"}
        </button>
      </div>
    </form>
  );
}
