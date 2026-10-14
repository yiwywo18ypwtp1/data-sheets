import { describe, expect, it } from "vitest";
import type { Row } from "@/lib/domain/row";
import { appendCards, moveCard, neighbourKey, replaceCard, type Columns } from "./board";

const row = (id: string, status: string | null): Row => ({ id, values: { fld_status: status }, createdAt: "", updatedAt: "", rev: 1 });
const board = (): Columns => [
  { key: null, count: 1, rows: [row("row_a", null)] },
  { key: "opt_todo", count: 12, rows: [row("row_b", "opt_todo"), row("row_c", "opt_todo")] },
  { key: "opt_done", count: 0, rows: [] },
];

describe("kanban board", () => {
  it("moves a card to the top of another column and sets the stacking field", () => {
    const next = moveCard(board(), "row_c", "fld_status", "opt_done")!;
    expect(next[1]).toMatchObject({ count: 11, rows: [{ id: "row_b" }] });
    expect(next[2].count).toBe(1);
    expect(next[2].rows[0]).toMatchObject({ id: "row_c", values: { fld_status: "opt_done" } });
    // Into "no value".
    expect(moveCard(next, "row_c", "fld_status", null)![0].rows.map((card) => card.id)).toEqual(["row_c", "row_a"]);
  });

  it("does nothing for the same column, an unknown card or column", () => {
    expect(moveCard(board(), "row_b", "fld_status", "opt_todo")).toBeNull();
    expect(moveCard(board(), "row_x", "fld_status", "opt_done")).toBeNull();
    expect(moveCard(board(), "row_b", "fld_status", "opt_gone")).toBeNull();
  });

  it("finds the neighbouring column for keyboard moves", () => {
    expect(neighbourKey(board(), "row_b", -1)).toBeNull();
    expect(neighbourKey(board(), "row_b", 1)).toBe("opt_done");
    expect(neighbourKey(board(), "row_a", -1)).toBeUndefined();
  });

  it("replaces a card with the server's version and appends pages without duplicates", () => {
    const updated = { ...row("row_b", "opt_todo"), rev: 5 };
    expect(replaceCard(board(), updated)[1].rows[0].rev).toBe(5);
    const more = appendCards(board(), "opt_todo", [row("row_c", "opt_todo"), row("row_d", "opt_todo")], 12);
    expect(more[1].rows.map((card) => card.id)).toEqual(["row_b", "row_c", "row_d"]);
  });
});
