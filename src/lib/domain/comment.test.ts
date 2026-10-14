import { describe, expect, it } from "vitest";
import { commentInputSchema, commentSegments, commentText, mentionedUserIds, mentionQueryAt, toStoredBody } from "./comment";

const eddie = { id: "usr_editor", name: "Eddie Editor" };
const ed = { id: "usr_ed", name: "Eddie" };

describe("comment mentions", () => {
  it("turns picked names into tokens, longest name first, and leaves typed names alone", () => {
    expect(toStoredBody("@Eddie Editor and @Eddie, see @Vera", [ed, eddie])).toBe("@[usr_editor] and @[usr_ed], see @Vera");
    // A name inside a longer word isn't a mention.
    expect(toStoredBody("@Eddies", [ed])).toBe("@Eddies");
  });

  it("can't be tricked into a mention by typing a token", () => {
    const body = toStoredBody("hi @[usr_creator]", []);
    expect(mentionedUserIds(body)).toEqual([]);
  });

  it("finds mentioned users once each and splits the body for rendering", () => {
    const body = "@[usr_editor] ping @[usr_viewer] and @[usr_editor] again";
    expect(mentionedUserIds(body)).toEqual(["usr_editor", "usr_viewer"]);
    expect(commentSegments("x @[usr_editor]!")).toEqual([
      { kind: "text", text: "x " },
      { kind: "mention", userId: "usr_editor" },
      { kind: "text", text: "!" },
    ]);
    expect(commentText(body, (id) => (id === "usr_editor" ? "Eddie Editor" : undefined))).toBe("@Eddie Editor ping @unknown user and @Eddie Editor again");
  });

  it("detects the @query being typed before the caret", () => {
    expect(mentionQueryAt("hello @Ed", 9)).toEqual({ start: 6, query: "Ed" });
    expect(mentionQueryAt("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionQueryAt("mail@example", 12)).toBeNull(); // an email address isn't a mention
    expect(mentionQueryAt("@Eddie Editor done", 18)).toBeNull();
  });

  it("validates the body like the server does", () => {
    expect(commentInputSchema.safeParse({ body: "   " }).success).toBe(false);
    expect(commentInputSchema.safeParse({ body: "x".repeat(5001) }).success).toBe(false);
    expect(commentInputSchema.parse({ body: "  ok " })).toEqual({ body: "ok" });
  });
});
