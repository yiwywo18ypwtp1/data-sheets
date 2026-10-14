import { describe, expect, it } from "vitest";
import { History, HISTORY_LIMIT } from "./history";
import { planPaste } from "./paste";
import { parseTsv, toTsv } from "./tsv";

describe("TSV", () => {
  it("round-trips values with tabs, line breaks and quotes", () => {
    const rows = [
      ["a", "b\tc", 'say "hi"'],
      ["line1\nline2", "", "1 234,50"],
    ];
    expect(parseTsv(toTsv(rows))).toEqual(rows);
  });

  it("reads Google Sheets / Excel output with CRLF and a trailing line break", () => {
    expect(parseTsv("1\t2\r\n3\t4\r\n")).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
    expect(parseTsv("only")).toEqual([["only"]]);
    expect(parseTsv("")).toEqual([]);
  });
});

describe("planPaste", () => {
  const bounds = { rows: 100, cols: 10 };
  const range = (top: number, left: number, bottom = top, right = left) => ({ top, left, bottom, right });
  const cells = (plan: ReturnType<typeof planPaste>) =>
    Array.from({ length: plan!.rows }, (_, r) => Array.from({ length: plan!.cols }, (_, c) => plan!.textAt(r, c)));

  it("pastes a block once from the active cell", () => {
    const plan = planPaste([["a", "b"], ["c", "d"]], range(5, 2), bounds)!;
    expect(plan).toMatchObject({ top: 5, left: 2, rows: 2, cols: 2, extraRows: 0 });
    expect(cells(plan)).toEqual([["a", "b"], ["c", "d"]]);
  });

  it("fills a selection with a single value", () => {
    expect(cells(planPaste([["x"]], range(0, 0, 2, 1), bounds))).toEqual([["x", "x"], ["x", "x"], ["x", "x"]]);
  });

  it("repeats one column across a selection that is a multiple of it", () => {
    const plan = planPaste([["1"], ["2"], ["3"]], range(0, 0, 2, 4), bounds)!;
    expect(plan.cols).toBe(5);
    expect(cells(plan)[1]).toEqual(["2", "2", "2", "2", "2"]);
  });

  it("pastes once when the selection isn't a multiple of the block", () => {
    const plan = planPaste([["1"], ["2"], ["3"]], range(0, 0, 0, 4), bounds)!;
    expect(plan).toMatchObject({ rows: 3, cols: 1 });
  });

  it("cuts off columns past the edge and reports rows past the end", () => {
    const plan = planPaste([["a", "b", "c"], ["d", "e", "f"], ["g", "h", "i"]], range(98, 8), bounds)!;
    expect(plan).toMatchObject({ cols: 2, rows: 3, extraRows: 1 });
  });

  it("returns null for an empty clipboard", () => {
    expect(planPaste([], range(0, 0), bounds)).toBeNull();
  });
});

describe("History", () => {
  const entry = (label: string) => ({ label, changes: [{ rowId: "r", fieldId: "f", before: 1, after: 2, row: 0, col: 0 }] });

  it("undoes and redoes in order; a new action clears redo", () => {
    const history = new History();
    history.push(entry("a"));
    history.push(entry("b"));
    expect(history.undo()?.label).toBe("b");
    expect(history.redo()?.label).toBe("b");
    expect(history.undo()?.label).toBe("b");
    history.push(entry("c"));
    expect(history.redo()).toBeNull();
    expect(history.undo()?.label).toBe("c");
    expect(history.undo()?.label).toBe("a");
    expect(history.undo()).toBeNull();
  });

  it("ignores empty actions and keeps a bounded number of steps", () => {
    const history = new History();
    history.push({ label: "nothing", changes: [] });
    expect(history.undo()).toBeNull();
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) history.push(entry(String(i)));
    let steps = 0;
    while (history.undo()) steps++;
    expect(steps).toBe(HISTORY_LIMIT);
  });
});
