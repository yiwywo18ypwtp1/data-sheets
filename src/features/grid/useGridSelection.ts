import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from "react";
import type { GridStore } from "./GridStore";
import { collapsed, movedCorner, navigate, selectColumns, selectRows, type Bounds, type CellPosition, type Selection } from "./selection";

type Drag = { kind: "cells" } | { kind: "rows" } | { kind: "columns" };

/** What the pointer is over, read from data attributes on cells, row numbers and headers. */
function hitTest(target: EventTarget | null): { kind: "cell"; cell: CellPosition } | { kind: "row"; row: number } | { kind: "column"; col: number } | null {
  if (!(target instanceof Element)) return null;
  const cell = target.closest<HTMLElement>("[data-row][data-col]");
  if (cell) return { kind: "cell", cell: { row: Number(cell.dataset.row), col: Number(cell.dataset.col) } };
  const gutter = target.closest<HTMLElement>("[data-row-gutter]");
  if (gutter) return { kind: "row", row: Number(gutter.dataset.rowGutter) };
  const header = target.closest<HTMLElement>("[data-header-col]");
  if (header) return { kind: "column", col: Number(header.dataset.headerCol) };
  return null;
}

/**
 * Keyboard and mouse selection for the grid. The rules live in selection.ts as pure
 * functions; this hook only translates DOM events into them and scrolls the moved
 * cell into view.
 */
export function useGridSelection(store: GridStore, getBounds: () => Bounds, scrollToCell: (cell: CellPosition) => void) {
  const drag = useRef<Drag | null>(null);

  useEffect(() => {
    const stop = () => {
      drag.current = null;
    };
    window.addEventListener("pointerup", stop);
    return () => window.removeEventListener("pointerup", stop);
  }, []);

  /** Handles navigation keys; returns false for keys that aren't navigation, so editing can take them. */
  function handleKey(event: KeyboardEvent<HTMLElement>): boolean {
    const before = store.selection;
    const after = navigate(before, event, getBounds());
    if (!after) return false;
    event.preventDefault();
    store.setSelection(after);
    scrollToCell(movedCorner(before, after));
    return true;
  }

  function onPointerDown(event: PointerEvent<HTMLElement>) {
    if (event.button !== 0 || (event.target instanceof Element && event.target.closest("a, button"))) return;
    const hit = hitTest(event.target);
    if (!hit) return;
    const bounds = getBounds();
    const current = store.selection;
    const extend = event.shiftKey && current !== null;
    let next: Selection;

    if (hit.kind === "cell") {
      next = extend ? { anchor: current.anchor, focus: hit.cell } : collapsed(hit.cell);
      drag.current = { kind: "cells" };
    } else if (hit.kind === "row") {
      next = selectRows(extend ? current.anchor.row : hit.row, hit.row, bounds);
      drag.current = { kind: "rows" };
    } else {
      next = selectColumns(extend ? current.anchor.col : hit.col, hit.col, bounds);
      drag.current = { kind: "columns" };
    }
    store.setSelection(next);
  }

  /** Dragging with the button held moves the far corner over cells, rows or columns. */
  function onPointerMove(event: PointerEvent<HTMLElement>) {
    const current = store.selection;
    const hit = hitTest(event.target);
    if (!drag.current || !current || !hit) return;
    const bounds = getBounds();
    const row = hit.kind === "cell" ? hit.cell.row : hit.kind === "row" ? hit.row : null;
    const col = hit.kind === "cell" ? hit.cell.col : hit.kind === "column" ? hit.col : null;

    let focus: CellPosition | null = null;
    if (drag.current.kind === "cells" && hit.kind === "cell") focus = hit.cell;
    if (drag.current.kind === "rows" && row !== null) focus = { row, col: bounds.cols - 1 };
    if (drag.current.kind === "columns" && col !== null) focus = { row: bounds.rows - 1, col };
    if (focus && (focus.row !== current.focus.row || focus.col !== current.focus.col)) {
      store.setSelection({ anchor: current.anchor, focus });
    }
  }

  return { handleKey, onPointerDown, onPointerMove };
}
