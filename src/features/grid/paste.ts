import type { Range } from "./selection";

/**
 * Where a pasted block goes, following spreadsheet rules:
 * - a single value pasted into a larger selection fills the whole selection;
 * - a block pasted into a selection that is an exact multiple of its size is repeated
 *   to fill it (one column of 3 values into 3 rows × 5 columns fills all 5 columns);
 * - otherwise the block is pasted once, from the selection's top-left cell.
 * Columns past the last one are cut off (fields can't be added by pasting); rows past
 * the last one are reported as `extraRows`, so the user can choose to add them.
 */
export type PastePlan = {
  top: number;
  left: number;
  rows: number;
  cols: number;
  extraRows: number;
  /** The clipboard text for a target cell, by offset from the plan's top-left. */
  textAt: (rowOffset: number, colOffset: number) => string;
};

export function planPaste(clip: string[][], selection: Range, bounds: { rows: number; cols: number }): PastePlan | null {
  const clipRows = clip.length;
  const clipCols = Math.max(0, ...clip.map((row) => row.length));
  if (clipRows === 0 || clipCols === 0) return null;

  const selectionRows = selection.bottom - selection.top + 1;
  const selectionCols = selection.right - selection.left + 1;
  const repeats = selectionRows % clipRows === 0 && selectionCols % clipCols === 0 && (selectionRows > clipRows || selectionCols > clipCols);

  const rows = repeats ? selectionRows : clipRows;
  const cols = Math.min(repeats ? selectionCols : clipCols, bounds.cols - selection.left);
  return {
    top: selection.top,
    left: selection.left,
    rows,
    cols,
    extraRows: Math.max(0, selection.top + rows - bounds.rows),
    textAt: (rowOffset, colOffset) => clip[rowOffset % clipRows][colOffset % clipCols] ?? "",
  };
}
