import { createContext, useContext } from "react";
import type { CellValue } from "@/lib/domain/cell";
import type { GridStore } from "./GridStore";

export type CommitMove = "down" | "up" | "right" | "left" | "none";

/**
 * What cell editors need from the grid. Passed through context instead of props so
 * the memoized rows don't get new props whenever the grid re-renders.
 */
export type GridEditing = {
  store: GridStore;
  locale: string;
  timeZone: string;
  /** Saves `value` into the cell being edited (if it changed) and moves the selection. */
  commit: (value: CellValue, move: CommitMove) => void;
  cancel: () => void;
};

export const GridEditingContext = createContext<GridEditing | null>(null);

export function useGridEditing(): GridEditing {
  const context = useContext(GridEditingContext);
  if (!context) throw new Error("Cell editors must be rendered inside the grid");
  return context;
}
