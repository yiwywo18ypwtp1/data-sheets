import { z } from "zod";

/**
 * Comments on a record. A mention is stored as a token with the user's id, `@[usr_x]`,
 * so renaming a user doesn't break old comments and the server knows exactly whom to
 * notify. The composer shows names (`@Eddie Editor`) and turns the people picked from
 * its list into tokens on submit (`toStoredBody`).
 */

export const MAX_COMMENT_LENGTH = 5000;

/** What the composer and `POST …/comments` accept; the server checks the mentioned users exist. */
export const commentInputSchema = z.object({
  body: z.string().trim().min(1, "Write a comment first").max(MAX_COMMENT_LENGTH, `At most ${MAX_COMMENT_LENGTH} characters`),
});
export type CommentInput = z.infer<typeof commentInputSchema>;

export type Comment = {
  id: string;
  rowId: string;
  author: { userId: string; name: string };
  /** Text with mention tokens. */
  body: string;
  /** Mentioned user ids, in order of first mention. */
  mentions: string[];
  createdAt: string;
};

/** A mention of the current user, for the inbox (`GET /api/mentions`). */
export type Mention = {
  commentId: string;
  baseId: string;
  tableId: string;
  tableName: string;
  viewId: string;
  rowId: string;
  /** The record's primary value. Empty if the record was deleted. */
  recordLabel: string;
  by: string;
  body: string;
  createdAt: string;
  read: boolean;
};

const MENTION = /@\[([A-Za-z0-9_-]{1,64})\]/g;

export function mentionedUserIds(body: string): string[] {
  return [...new Set([...body.matchAll(MENTION)].map((match) => match[1]))];
}

export type CommentSegment = { kind: "text"; text: string } | { kind: "mention"; userId: string };

/** The body split into text and mentions, for rendering mentions as names. */
export function commentSegments(body: string): CommentSegment[] {
  const segments: CommentSegment[] = [];
  let last = 0;
  for (const match of body.matchAll(MENTION)) {
    if (match.index > last) segments.push({ kind: "text", text: body.slice(last, match.index) });
    segments.push({ kind: "mention", userId: match[1] });
    last = match.index + match[0].length;
  }
  if (last < body.length) segments.push({ kind: "text", text: body.slice(last) });
  return segments;
}

/** Plain text with names instead of tokens: inbox excerpts, toasts. */
export function commentText(body: string, nameOf: (userId: string) => string | undefined): string {
  return commentSegments(body)
    .map((segment) => (segment.kind === "text" ? segment.text : `@${nameOf(segment.userId) ?? "unknown user"}`))
    .join("");
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The composer's text → the stored body: `@Name` of each user picked from the mention
 * list becomes `@[id]`. Longer names go first, so "@Eddie Editor" wins over a user
 * called "Eddie". A name typed by hand without picking stays plain text: no surprise
 * notifications. A literal `@[` typed by the user is broken up, so it can't forge a mention.
 */
export function toStoredBody(text: string, picked: { id: string; name: string }[]): string {
  let body = text.replace(/@\[/g, "@ [");
  const users = [...new Map(picked.map((user) => [user.id, user])).values()].sort((a, b) => b.name.length - a.name.length);
  for (const user of users) {
    // Not followed by a letter or digit: "@Eddie" mustn't match inside "@Eddies".
    body = body.replace(new RegExp(`@${escapeRegExp(user.name)}(?![\\p{L}\\p{N}])`, "gu"), `@[${user.id}]`);
  }
  return body;
}

/** The `@query` being typed right before the caret, if any: what the mention list filters by. */
export function mentionQueryAt(text: string, caret: number): { start: number; query: string } | null {
  const match = /(^|\s)@([^\s@[\]]{0,30})$/u.exec(text.slice(0, caret));
  return match ? { start: caret - match[2].length - 1, query: match[2] } : null;
}
