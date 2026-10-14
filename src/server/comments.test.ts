import { beforeEach, describe, expect, it, vi } from "vitest";
import * as commentRoute from "@/app/api/tables/[id]/comments/[commentId]/route";
import * as mentionsRoute from "@/app/api/mentions/route";
import * as readRoute from "@/app/api/mentions/read/route";
import * as commentsRoute from "@/app/api/tables/[id]/rows/[rowId]/comments/route";
import type { Comment, Mention } from "@/lib/domain/comment";
import { eventsSince, latestSeq } from "./events";
import { TABLE_IDS } from "./seed";

let userId = "usr_creator";
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === "ds_user" ? { value: userId } : undefined) }),
}));
// Route handlers that only read the cookie call `connection()`, which needs a real request scope.
vi.mock("next/server", async (original) => ({ ...(await original<typeof import("next/server")>()), connection: async () => undefined }));
beforeEach(() => {
  userId = "usr_creator";
});

const table = TABLE_IDS.orders;
const rowParams = (rowId: string) => ({ params: Promise.resolve({ id: table, rowId }) });

async function post(rowId: string, body: unknown) {
  const response = await commentsRoute.POST(new Request(`http://localhost/api/tables/${table}/rows/${rowId}/comments`, { method: "POST", body: JSON.stringify({ body }) }), rowParams(rowId));
  return { status: response.status, json: (await response.json()) as { comment: Comment; error: { fieldErrors?: Record<string, string> } } };
}
async function list(rowId: string): Promise<Comment[]> {
  const response = await commentsRoute.GET(new Request(`http://localhost/api/tables/${table}/rows/${rowId}/comments`), rowParams(rowId));
  return ((await response.json()) as { comments: Comment[] }).comments;
}
async function mentions(): Promise<{ mentions: Mention[]; unread: number }> {
  return (await mentionsRoute.GET(new Request("http://localhost/api/mentions"), { params: Promise.resolve({}) })).json();
}

describe("comments", () => {
  it("adds comments in order, logs a realtime event, and notifies mentioned users (not the author)", async () => {
    const since = latestSeq(table);
    const first = await post("row_o_000001", "Please check @[usr_editor] and me @[usr_creator]");
    expect(first.status).toBe(201);
    await post("row_o_000001", "second");
    expect((await list("row_o_000001")).map((comment) => comment.body)).toEqual(["Please check @[usr_editor] and me @[usr_creator]", "second"]);
    expect(first.json.comment.mentions).toEqual(["usr_editor", "usr_creator"]);

    const events = eventsSince(table, since).events.filter((event) => event.kind === "comment");
    expect(events).toHaveLength(2);

    expect((await mentions()).unread).toBe(0); // Cora mentioned herself
    userId = "usr_editor";
    const inbox = await mentions();
    expect(inbox.unread).toBe(1);
    expect(inbox.mentions[0]).toMatchObject({ rowId: "row_o_000001", tableName: "Orders", by: "Cora Creator", read: false, recordLabel: "ORD-000001" });

    await readRoute.POST(new Request("http://localhost/api/mentions/read", { method: "POST", body: JSON.stringify({ commentIds: [first.json.comment.id] }) }), { params: Promise.resolve({}) });
    expect((await mentions()).unread).toBe(0);
  });

  it("rejects empty comments, unknown users and missing records", async () => {
    expect((await post("row_o_000002", "  ")).status).toBe(400);
    const unknown = await post("row_o_000002", "hi @[usr_ghost]");
    expect(unknown.status).toBe(400);
    expect(unknown.json.error.fieldErrors?.body).toContain("usr_ghost");
    expect((await post("row_nope", "hi")).status).toBe(404);
  });

  it("lets viewers comment, and only the author delete", async () => {
    userId = "usr_viewer";
    const { json } = await post("row_o_000003", "viewer here");
    const remove = () =>
      commentRoute.DELETE(new Request(`http://localhost/api/tables/${table}/comments/${json.comment.id}`, { method: "DELETE" }), {
        params: Promise.resolve({ id: table, commentId: json.comment.id }),
      });
    userId = "usr_creator";
    expect((await remove()).status).toBe(403);
    userId = "usr_viewer";
    expect((await remove()).status).toBe(204);
    expect(await list("row_o_000003")).toEqual([]);
  });
});
