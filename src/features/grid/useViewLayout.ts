import { useEffect, useRef, useState } from "react";
import type { View } from "@/lib/domain/view";
import type { ViewLayout } from "./layout";

const SAVE_DELAY_MS = 400;

/**
 * Column order, widths and hidden fields of the open view. Changes show at once and
 * are saved shortly after (a column resize produces dozens of changes; one save is
 * enough), through the shared view saver (see useSavedView).
 *
 * Viewers can rearrange columns for themselves, but nothing is saved for them.
 */
export function useViewLayout(view: View, save: ((patch: Partial<View>) => Promise<unknown>) | null) {
  const [layout, setLayout] = useState<ViewLayout>({
    fieldOrder: view.fieldOrder,
    hiddenFieldIds: view.hiddenFieldIds,
    columnWidths: view.columnWidths,
  });
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unsaved = useRef<ViewLayout | null>(null);

  function flush() {
    const next = unsaved.current;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    unsaved.current = null;
    if (!next || !save) return;
    save(next).then(
      () => setError(null),
      () => setError("Couldn't save the column layout"),
    );
  }

  // Switching views right after a resize unmounts the grid: save now instead of dropping the change.
  const flushRef = useRef(flush);
  useEffect(() => {
    flushRef.current = flush;
  });
  useEffect(() => () => flushRef.current(), []);

  function update(change: (current: ViewLayout) => ViewLayout) {
    const next = change(layout);
    if (next === layout) return;
    setLayout(next);
    if (!save) return;
    unsaved.current = next;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, SAVE_DELAY_MS);
  }

  return { layout, update, error };
}
