import { useEffect, useState } from "react";
import type { OpenRecord } from "./RecordPanel";

/**
 * The record open in the side panel, mirrored into `?record=<rowId>` so the address can
 * be shared (mentions link to it too). Other query parameters (`?filter=`) are kept.
 */
export function useOpenRecord(initial: OpenRecord | null) {
  const [record, setRecord] = useState<OpenRecord | null>(initial);
  const rowId = record?.rowId ?? null;
  useEffect(() => {
    const url = new URL(window.location.href);
    if (rowId) url.searchParams.set("record", rowId);
    else url.searchParams.delete("record");
    if (url.href !== window.location.href) window.history.replaceState(window.history.state, "", url);
  }, [rowId]);
  return [record, setRecord] as const;
}
