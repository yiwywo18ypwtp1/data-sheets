import { describe, expect, it } from "vitest";
import {
  collapsed,
  movedCorner,
  navigate,
  parseRowSelectionKey,
  rangeOf,
  rowSelectionKey,
  type Bounds,
  type KeyInput,
  type Selection,
} from "./selection";

const bounds: Bounds = { rows: 50_000, cols: 30, pageRows: 20 };
const key = (k: string, mods: Partial<KeyInput> = {}): KeyInput => ({ key: k, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...mods });
const at = (row: number, col: number) => collapsed({ row, col });
const range = (anchor: [number, number], focus: [number, number]): Selection => ({
  anchor: { row: anchor[0], col: anchor[1] },
  focus: { row: focus[0], col: focus[1] },
});

describe("navigate", () => {
  it("moves the active cell with arrows and stops at the edges", () => {
    expect(navigate(at(5, 5), key("ArrowDown"), bounds)).toEqual(at(6, 5));
    expect(navigate(at(5, 5), key("ArrowLeft"), bounds)).toEqual(at(5, 4));
    expect(navigate(at(0, 0), key("ArrowUp"), bounds)).toEqual(at(0, 0));
    expect(navigate(at(0, 29), key("ArrowRight"), bounds)).toEqual(at(0, 29));
  });

  it("starts at the first cell when nothing is selected", () => {
    expect(navigate(null, key("ArrowDown"), bounds)).toEqual(at(1, 0));
  });

  it("extends from the far corner with Shift, keeping the active cell", () => {
    const once = navigate(at(5, 5), key("ArrowDown", { shiftKey: true }), bounds)!;
    const twice = navigate(once, key("ArrowRight", { shiftKey: true }), bounds)!;
    expect(twice).toEqual(range([5, 5], [6, 6]));
    expect(rangeOf(twice)).toEqual({ top: 5, bottom: 6, left: 5, right: 6 });
    // a plain arrow collapses the range, moving from the active cell
    expect(navigate(twice, key("ArrowDown"), bounds)).toEqual(at(6, 5));
  });

  it("jumps with Cmd/Ctrl", () => {
    expect(navigate(at(10, 10), key("ArrowDown", { metaKey: true }), bounds)).toEqual(at(49_999, 10));
    expect(navigate(at(10, 10), key("ArrowLeft", { ctrlKey: true }), bounds)).toEqual(at(10, 0));
    expect(navigate(at(10, 10), key("Home", { metaKey: true }), bounds)).toEqual(at(0, 0));
    expect(navigate(at(10, 10), key("End", { ctrlKey: true }), bounds)).toEqual(at(49_999, 29));
    expect(navigate(at(10, 10), key("End"), bounds)).toEqual(at(10, 29));
  });

  it("pages by the visible row count", () => {
    expect(navigate(at(10, 3), key("PageDown"), bounds)).toEqual(at(30, 3));
    expect(navigate(at(10, 3), key("PageUp"), bounds)).toEqual(at(0, 3));
    expect(navigate(at(10, 3), key("PageDown", { shiftKey: true }), bounds)).toEqual(range([10, 3], [30, 3]));
  });

  it("tabs right, wraps to the next row, and leaves the grid past the ends", () => {
    expect(navigate(at(3, 28), key("Tab"), bounds)).toEqual(at(3, 29));
    expect(navigate(at(3, 29), key("Tab"), bounds)).toEqual(at(4, 0));
    expect(navigate(at(4, 0), key("Tab", { shiftKey: true }), bounds)).toEqual(at(3, 29));
    expect(navigate(at(49_999, 29), key("Tab"), bounds)).toBeNull();
    expect(navigate(at(0, 0), key("Tab", { shiftKey: true }), bounds)).toBeNull();
  });

  it("collapses with Escape, and ignores Escape when already collapsed", () => {
    expect(navigate(range([2, 2], [5, 6]), key("Escape"), bounds)).toEqual(at(2, 2));
    expect(navigate(at(2, 2), key("Escape"), bounds)).toBeNull();
  });

  it("selects everything, whole rows and whole columns", () => {
    expect(navigate(at(3, 3), key("a", { metaKey: true }), bounds)).toEqual(range([0, 0], [49_999, 29]));
    expect(navigate(range([3, 3], [4, 5]), key(" ", { shiftKey: true }), bounds)).toEqual(range([3, 0], [4, 29]));
    expect(navigate(range([3, 3], [4, 5]), key(" ", { ctrlKey: true }), bounds)).toEqual(range([0, 3], [49_999, 5]));
  });

  it("ignores other keys and empty grids", () => {
    expect(navigate(at(1, 1), key("x"), bounds)).toBeNull();
    expect(navigate(at(1, 1), key("a"), bounds)).toBeNull();
    expect(navigate(null, key("ArrowDown"), { rows: 0, cols: 5, pageRows: 10 })).toBeNull();
  });
});

describe("movedCorner", () => {
  it("follows the active cell, or the far corner when extending", () => {
    expect(movedCorner(at(1, 1), at(2, 1))).toEqual({ row: 2, col: 1 });
    expect(movedCorner(at(1, 1), range([1, 1], [9, 1]))).toEqual({ row: 9, col: 1 });
  });
});

describe("rowSelectionKey", () => {
  const selection = range([4, 6], [2, 3]);

  it("describes the row's slice of the selection", () => {
    expect(rowSelectionKey(selection, 1)).toBe("");
    expect(rowSelectionKey(selection, 2)).toBe("3:6:1:0:-1");
    expect(rowSelectionKey(selection, 3)).toBe("3:6:0:0:-1");
    expect(rowSelectionKey(selection, 4)).toBe("3:6:0:1:6");
    expect(rowSelectionKey(null, 4)).toBe("");
  });

  it("round-trips through the parser", () => {
    expect(parseRowSelectionKey("3:6:0:1:6")).toEqual({ left: 3, right: 6, top: false, bottom: true, activeCol: 6 });
    expect(parseRowSelectionKey("")).toBeNull();
  });
});
