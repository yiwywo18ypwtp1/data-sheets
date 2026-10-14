import { useEffect, useRef, useState } from "react";
import type { View } from "@/lib/domain/view";
import { ApiRequestError, saveView } from "./api";
import type { ViewLayout } from "./layout";

const SAVE_DELAY_MS = 400;

/**
 * Column order, widths and hidden fields of the open view. Changes show at once and
 * are saved shortly after (a column resize produces dozens of changes; one save is
 * enough). Saves go out one at a time, the latest layout wins.
 *
 * Concurrency: the save sends the version it's based on (If-Match). If someone else
 * saved the view meanwhile (412), the layout is re-applied on top of their version,
 * so their filter or sort changes aren't overwritten, and sent again.
 *
 * Viewers can rearrange columns for themselves, but nothing is saved for them.
 */
export function useViewLayout(view: View, version: number, canSave: boolean) {
  const [layout, setLayout] = useState<ViewLayout>({
    fieldOrder: view.fieldOrder,
    hiddenFieldIds: view.hiddenFieldIds,
    columnWidths: view.columnWidths,
  });
  const [error, setError] = useState<string | null>(null);
  const saved = useRef({ view, version });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef(false);
  const queued = useRef<ViewLayout | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  async function save(next: ViewLayout): Promise<void> {
    if (inFlight.current) {
      queued.current = next;
      return;
    }
    inFlight.current = true;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const result = await saveView({ ...saved.current.view, ...next }, saved.current.version);
          saved.current = result;
          setError(null);
          break;
        } catch (cause) {
          const current = cause instanceof ApiRequestError && cause.status === 412 ? (cause.details as { view: View; version: number } | undefined) : undefined;
          if (!current || attempt === 1) throw cause;
          saved.current = current;
        }
      }
    } catch {
      setError("Couldn't save the column layout");
    } finally {
      inFlight.current = false;
      const pending = queued.current;
      queued.current = null;
      if (pending) void save(pending);
    }
  }

  function update(change: (current: ViewLayout) => ViewLayout) {
    const next = change(layout);
    if (next === layout) return;
    setLayout(next);
    if (!canSave) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(next), SAVE_DELAY_MS);
  }

  return { layout, update, error };
}
