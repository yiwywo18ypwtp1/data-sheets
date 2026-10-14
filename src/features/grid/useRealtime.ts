import { useEffect, useState } from "react";
import type { CellValue } from "@/lib/domain/cell";
import type { Field } from "@/lib/domain/field";
import type { View } from "@/lib/domain/view";
import { createCellFormatter } from "@/lib/format";
import { getClientId, sendPresence } from "./api";
import type { GridStore } from "./GridStore";
import type { GridColumn } from "./layout";
import { connectRealtime, type RealtimeStatus, type TableEvent } from "./realtime";
import { emitCommentEvent } from "@/features/records/commentBus";
import { notifyMention } from "@/features/records/mentions";
import { pushToast } from "./toastStore";

const PRESENCE_HEARTBEAT_MS = 20_000;
const PRESENCE_DELAY_MS = 200;

type Options = {
  tableId: string;
  viewId: string;
  store: GridStore;
  fields: Field[];
  columns: GridColumn[];
  locale: string;
  timeZone: string;
  /** Another user changed the fields: the page must reload its schema. */
  onSchemaChange: (event: Extract<TableEvent, { kind: "schema" }>) => void;
  /** Another user saved this view. */
  onViewSaved: (view: View, version: number, by: string) => void;
  /** A comment mentioning this user offers to open its record. */
  currentUserId: string;
  onOpenRecord: (rowId: string) => void;
};

/**
 * Keeps the open grid in sync with other tabs and users: applies their row changes,
 * reports conflicts with a "Keep mine" action, follows schema and view changes, sends
 * this tab's selected cell as presence and resends unsaved edits when the browser is
 * back online. Returns the connection status for the toolbar.
 */
export function useRealtime({ tableId, viewId, store, fields, columns, locale, timeZone, onSchemaChange, onViewSaved, currentUserId, onOpenRecord }: Options): RealtimeStatus {
  const [status, setStatus] = useState<RealtimeStatus>("connecting");

  // Handlers read the latest props through a ref-like closure object, so the connection isn't reopened on every render.
  const [handlers] = useState(() => ({ fields, locale, timeZone, onSchemaChange, onViewSaved, currentUserId, onOpenRecord }));
  useEffect(() => {
    Object.assign(handlers, { fields, locale, timeZone, onSchemaChange, onViewSaved, currentUserId, onOpenRecord });
  });

  useEffect(() => {
    const describe = (fieldId: string, value: CellValue) => {
      const field = handlers.fields.find((candidate) => candidate.id === fieldId);
      const text = field ? createCellFormatter(field, { locale: handlers.locale, timeZone: handlers.timeZone, labelOf: store.getLabel })(value) : String(value ?? "");
      return text === "" ? "empty" : `“${text.slice(0, 40)}”`;
    };

    const onEvent = (event: TableEvent) => {
      if (event.origin.clientId === getClientId()) return; // this tab's own change, already applied
      switch (event.kind) {
        case "rows": {
          const { conflicts, deletedWhileEditing } = store.applyRemoteRows(event.rows, event.deleted, event.origin.name);
          if (deletedWhileEditing) pushToast({ message: `${event.origin.name} deleted the record you were editing.`, tone: "warning" });
          for (const conflict of conflicts) {
            const field = handlers.fields.find((candidate) => candidate.id === conflict.fieldId);
            pushToast({
              tone: "warning",
              message: `${conflict.by} changed ${field?.name ?? "a cell"} to ${describe(conflict.fieldId, conflict.theirs)} after you set it to ${describe(conflict.fieldId, conflict.mine)}.`,
              action: { label: "Keep mine", run: () => store.writeCells([{ rowId: conflict.rowId, fieldId: conflict.fieldId, value: conflict.mine }]) },
            });
          }
          break;
        }
        case "reload":
          store.refresh();
          break;
        case "schema":
          handlers.onSchemaChange(event);
          break;
        case "view":
          if (event.view.id === viewId) handlers.onViewSaved(event.view, event.version, event.origin.name);
          break;
        case "comment":
          emitCommentEvent(event);
          if (event.comment?.mentions.includes(handlers.currentUserId)) notifyMention(event, handlers.onOpenRecord);
          break;
      }
    };

    const disconnect = connectRealtime(tableId, {
      onEvent,
      onReset: () => store.refresh(),
      onPresence: (entries) => store.setPresence(entries.filter((entry) => entry.clientId !== getClientId())),
      onStatus: setStatus,
    });
    const online = () => store.resendNow();
    window.addEventListener("online", online);
    return () => {
      disconnect();
      window.removeEventListener("online", online);
    };
  }, [tableId, viewId, store, handlers]);

  // Presence: the active cell, sent when it changes (a little delayed, so arrow-key runs send once) and as a heartbeat.
  useEffect(() => {
    let sentKey: string | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cellNow = () => {
      const rowId = store.activeRowId();
      const field = store.selection ? columns[store.selection.anchor.col]?.field : undefined;
      return rowId && field ? { rowId, fieldId: field.id } : null;
    };
    const send = () => {
      const cell = cellNow();
      sentKey = cell ? `${cell.rowId}:${cell.fieldId}` : "";
      sendPresence(tableId, viewId, cell).catch(() => undefined);
    };
    const unsubscribe = store.subscribe(() => {
      const cell = cellNow();
      const key = cell ? `${cell.rowId}:${cell.fieldId}` : "";
      if (key === sentKey) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(send, PRESENCE_DELAY_MS);
    });
    send();
    const heartbeat = setInterval(send, PRESENCE_HEARTBEAT_MS);
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
      clearInterval(heartbeat);
    };
  }, [tableId, viewId, store, columns]);

  return status;
}
