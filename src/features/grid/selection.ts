/**
 * Selection model and keyboard navigation, as pure functions (no DOM, no React),
 * so every key binding is unit-tested.
 *
 * A selection is a rectangle between two corners. `anchor` is the active cell (where
 * typing goes, like in Excel); `focus` is the opposite corner, moved by Shift+keys and
 * mouse drags. A collapsed selection has anchor === focus.
 * `row` is an index into the view's rows, `col` an index into its visible columns.
 */

export type CellPosition = { row: number; col: number };
export type Selection = { anchor: CellPosition; focus: CellPosition };
export type Range = { top: number; bottom: number; left: number; right: number };

export type Bounds = {
  rows: number;
  cols: number;
  /** Rows that fit on screen, for PageUp/PageDown. */
  pageRows: number;
};

export type KeyInput = Pick<KeyboardEvent, "key" | "shiftKey" | "metaKey" | "ctrlKey" | "altKey">;

export function rangeOf({ anchor, focus }: Selection): Range {
  return {
    top: Math.min(anchor.row, focus.row),
    bottom: Math.max(anchor.row, focus.row),
    left: Math.min(anchor.col, focus.col),
    right: Math.max(anchor.col, focus.col),
  };
}

export const collapsed = (cell: CellPosition): Selection => ({ anchor: cell, focus: cell });

const clamp = (value: number, max: number) => Math.max(0, Math.min(max, value));

function clampCell(cell: CellPosition, bounds: Bounds): CellPosition {
  return { row: clamp(cell.row, bounds.rows - 1), col: clamp(cell.col, bounds.cols - 1) };
}

/** Moves the active cell (collapsing the selection), or with Shift moves the far corner. */
function move(selection: Selection, to: (cell: CellPosition) => CellPosition, extend: boolean, bounds: Bounds): Selection {
  if (extend) return { anchor: selection.anchor, focus: clampCell(to(selection.focus), bounds) };
  return collapsed(clampCell(to(selection.anchor), bounds));
}

export function selectRows(fromRow: number, toRow: number, bounds: Bounds): Selection {
  return { anchor: { row: fromRow, col: 0 }, focus: { row: toRow, col: bounds.cols - 1 } };
}

export function selectColumns(fromCol: number, toCol: number, bounds: Bounds): Selection {
  return { anchor: { row: 0, col: fromCol }, focus: { row: bounds.rows - 1, col: toCol } };
}

/**
 * The selection after a key press, or null if the key isn't a navigation key here
 * (the caller then lets the browser handle it, e.g. Tab out of the grid).
 */
export function navigate(current: Selection | null, input: KeyInput, bounds: Bounds): Selection | null {
  if (bounds.rows === 0 || bounds.cols === 0) return null;
  const selection = current ?? collapsed({ row: 0, col: 0 });
  const mod = input.metaKey || input.ctrlKey;
  const extend = input.shiftKey;
  const lastRow = bounds.rows - 1;
  const lastCol = bounds.cols - 1;

  switch (input.key) {
    case "ArrowUp":
      return move(selection, (cell) => ({ ...cell, row: mod ? 0 : cell.row - 1 }), extend, bounds);
    case "ArrowDown":
      return move(selection, (cell) => ({ ...cell, row: mod ? lastRow : cell.row + 1 }), extend, bounds);
    case "ArrowLeft":
      return move(selection, (cell) => ({ ...cell, col: mod ? 0 : cell.col - 1 }), extend, bounds);
    case "ArrowRight":
      return move(selection, (cell) => ({ ...cell, col: mod ? lastCol : cell.col + 1 }), extend, bounds);

    case "Home":
      return move(selection, (cell) => (mod ? { row: 0, col: 0 } : { ...cell, col: 0 }), extend, bounds);
    case "End":
      return move(selection, (cell) => (mod ? { row: lastRow, col: lastCol } : { ...cell, col: lastCol }), extend, bounds);
    case "PageUp":
      return move(selection, (cell) => ({ ...cell, row: cell.row - bounds.pageRows }), extend, bounds);
    case "PageDown":
      return move(selection, (cell) => ({ ...cell, row: cell.row + bounds.pageRows }), extend, bounds);

    case "Tab": {
      // Tab walks right and wraps to the next row; past the last cell it leaves the grid.
      const { row, col } = selection.anchor;
      const index = row * bounds.cols + col + (input.shiftKey ? -1 : 1);
      if (index < 0 || index > lastRow * bounds.cols + lastCol) return null;
      return collapsed({ row: Math.floor(index / bounds.cols), col: index % bounds.cols });
    }

    case "Escape": {
      // Collapses a range; with nothing to collapse, Escape is left to others.
      const { anchor, focus } = selection;
      if (current === null || (anchor.row === focus.row && anchor.col === focus.col)) return null;
      return collapsed(anchor);
    }

    case "a":
    case "A":
      return mod ? { anchor: { row: 0, col: 0 }, focus: { row: lastRow, col: lastCol } } : null;

    case " ": {
      // Shift+Space selects the rows of the selection, Ctrl+Space its columns (as in Excel).
      const range = rangeOf(selection);
      if (input.shiftKey && !mod) return selectRows(range.top, range.bottom, bounds);
      if (input.ctrlKey && !input.shiftKey) return selectColumns(range.left, range.right, bounds);
      return null;
    }

    default:
      return null;
  }
}

/** The cell to bring into view after navigation: the corner that moved. */
export function movedCorner(before: Selection | null, after: Selection): CellPosition {
  const anchorMoved = !before || before.anchor.row !== after.anchor.row || before.anchor.col !== after.anchor.col;
  return anchorMoved ? after.anchor : after.focus;
}

/**
 * A row's part of the selection as one string, e.g. "2:5:1:0:3" (left, right, is top
 * edge, is bottom edge, active column or -1), or "" if the row isn't selected.
 * Rows subscribe to this primitive, so moving the selection re-renders only the
 * rows whose part actually changed.
 */
export function rowSelectionKey(selection: Selection | null, row: number): string {
  if (!selection) return "";
  const { top, bottom, left, right } = rangeOf(selection);
  if (row < top || row > bottom) return "";
  const active = selection.anchor.row === row ? selection.anchor.col : -1;
  return `${left}:${right}:${row === top ? 1 : 0}:${row === bottom ? 1 : 0}:${active}`;
}

export type RowSelection = { left: number; right: number; top: boolean; bottom: boolean; activeCol: number };

export function parseRowSelectionKey(key: string): RowSelection | null {
  if (key === "") return null;
  const [left, right, top, bottom, activeCol] = key.split(":").map(Number);
  return { left, right, top: top === 1, bottom: bottom === 1, activeCol };
}
