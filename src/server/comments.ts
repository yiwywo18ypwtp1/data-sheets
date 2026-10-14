import "server-only";
import { commentInputSchema, mentionedUserIds, type Comment, type Mention } from "@/lib/domain/comment";
import { newId } from "@/lib/domain/ids";
import type { User } from "@/lib/domain/user";
import { now } from "./clock";
import { getDb } from "./db";
import { ApiError, notFound, zodFieldErrors } from "./errors";
import { appendEvent, type Origin } from "./events";
import { getRowsByIds } from "./rows";

/**
 * Comments on records, with mentions. Anyone who can open the table can comment (viewers
 * too, as in Airtable's "commenter" role); only the author deletes a comment. Comments
 * outlive their record, so undoing a deletion brings them back with it.
 */

type CommentRecord = { id: string; row_id: string; user_id: string; user_name: string | null; body: string; created_at: string };

function toComment(record: CommentRecord): Comment {
  return {
    id: record.id,
    rowId: record.row_id,
    author: { userId: record.user_id, name: record.user_name ?? "A former user" },
    body: record.body,
    mentions: mentionedUserIds(record.body),
    createdAt: record.created_at,
  };
}

const SELECT_COMMENTS = "SELECT c.id, c.row_id, c.user_id, u.name AS user_name, c.body, c.created_at FROM comments c LEFT JOIN users u ON u.id = c.user_id";

/** A record's comments, oldest first, like a conversation. */
export function listComments(tableId: string, rowId: string): Comment[] {
  const records = getDb().prepare(`${SELECT_COMMENTS} WHERE c.row_id = ? AND c.table_id = ? ORDER BY c.created_at, c.rowid`).all(rowId, tableId) as CommentRecord[];
  return records.map(toComment);
}

export function addComment(tableId: string, rowId: string, input: unknown, author: User, origin: Origin): Comment {
  const parsed = commentInputSchema.safeParse(input);
  if (!parsed.success) throw new ApiError("VALIDATION_ERROR", 400, parsed.error.issues[0]?.message ?? "Invalid comment", { fieldErrors: zodFieldErrors(parsed.error.issues) });
  if (getRowsByIds(tableId, [rowId]).length === 0) throw notFound("Record");

  const db = getDb();
  const mentions = mentionedUserIds(parsed.data.body);
  const known = new Set(
    mentions.length === 0
      ? []
      : (db.prepare(`SELECT id FROM users WHERE id IN (${mentions.map(() => "?").join(", ")})`).all(...mentions) as { id: string }[]).map((user) => user.id),
  );
  const unknown = mentions.filter((id) => !known.has(id));
  if (unknown.length > 0) throw new ApiError("VALIDATION_ERROR", 400, "Mentioned an unknown user", { fieldErrors: { body: `Unknown user: ${unknown.join(", ")}` } });

  const comment: Comment = { id: newId("cmt"), rowId, author: { userId: author.id, name: author.name }, body: parsed.data.body, mentions, createdAt: now().toISOString() };
  db.transaction(() => {
    db.prepare("INSERT INTO comments (id, table_id, row_id, user_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(comment.id, tableId, rowId, author.id, comment.body, comment.createdAt);
    const notify = db.prepare("INSERT INTO mentions (comment_id, user_id) VALUES (?, ?)");
    // Mentioning yourself isn't a notification.
    for (const userId of mentions) if (userId !== author.id) notify.run(comment.id, userId);
    appendEvent(tableId, { kind: "comment", origin, rowId, comment });
  })();
  return comment;
}

export function deleteComment(tableId: string, commentId: string, user: User, origin: Origin): void {
  const db = getDb();
  const record = db.prepare("SELECT row_id, user_id FROM comments WHERE id = ? AND table_id = ?").get(commentId, tableId) as { row_id: string; user_id: string } | undefined;
  if (!record) throw notFound("Comment");
  if (record.user_id !== user.id) throw new ApiError("FORBIDDEN", 403, "Only the author can delete a comment");
  db.transaction(() => {
    db.prepare("DELETE FROM comments WHERE id = ?").run(commentId);
    appendEvent(tableId, { kind: "comment", origin, rowId: record.row_id, deletedId: commentId });
  })();
}

type MentionRecord = {
  comment_id: string;
  read_at: string | null;
  base_id: string;
  table_id: string;
  table_name: string;
  view_id: string;
  row_id: string;
  record_label: unknown;
  by_name: string | null;
  body: string;
  created_at: string;
};

/** The user's mentions, newest first, with where they are (table, its first view, the record's name). */
export function listMentions(userId: string, limit = 30): { mentions: Mention[]; unread: number } {
  const db = getDb();
  const records = db
    .prepare(
      `SELECT m.comment_id, m.read_at, t.base_id, t.id AS table_id, t.name AS table_name,
              (SELECT v.id FROM views v WHERE v.table_id = t.id ORDER BY v.position LIMIT 1) AS view_id,
              c.row_id, json_extract(r.cells, '$."' || t.primary_field_id || '"') AS record_label,
              u.name AS by_name, c.body, c.created_at
       FROM mentions m
       JOIN comments c ON c.id = m.comment_id
       JOIN tables t ON t.id = c.table_id
       LEFT JOIN rows r ON r.id = c.row_id
       LEFT JOIN users u ON u.id = c.user_id
       WHERE m.user_id = ?
       ORDER BY c.created_at DESC, c.rowid DESC LIMIT ?`,
    )
    .all(userId, limit) as MentionRecord[];
  const { unread } = db.prepare("SELECT count(*) AS unread FROM mentions WHERE user_id = ? AND read_at IS NULL").get(userId) as { unread: number };
  return {
    unread,
    mentions: records.map((record) => ({
      commentId: record.comment_id,
      baseId: record.base_id,
      tableId: record.table_id,
      tableName: record.table_name,
      viewId: record.view_id,
      rowId: record.row_id,
      recordLabel: record.record_label === null || record.record_label === undefined ? "" : String(record.record_label),
      by: record.by_name ?? "A former user",
      body: record.body,
      createdAt: record.created_at,
      read: record.read_at !== null,
    })),
  };
}

/** Marks the given mentions (or all of them) as read. */
export function markMentionsRead(userId: string, commentIds: string[] | null): void {
  const db = getDb();
  const at = now().toISOString();
  if (commentIds === null) {
    db.prepare("UPDATE mentions SET read_at = ? WHERE user_id = ? AND read_at IS NULL").run(at, userId);
    return;
  }
  const update = db.prepare("UPDATE mentions SET read_at = ? WHERE user_id = ? AND comment_id = ? AND read_at IS NULL");
  db.transaction(() => commentIds.forEach((id) => update.run(at, userId, id)))();
}
