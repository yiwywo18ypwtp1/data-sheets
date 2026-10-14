import Link from "next/link";
import { useRef, useState } from "react";
import type { Field } from "@/lib/domain/field";
import { Popover } from "./editors/Popover";
import { useOutsidePointerDown } from "./editors/useOutsidePointerDown";
import type { GridStore } from "./GridStore";
import type { RealtimeStatus } from "./realtime";
import { useGridStore } from "./useGridStore";

type GridToolbarProps = {
  store: GridStore;
  canEdit: boolean;
  primaryFieldId: string;
  fields: Field[];
  hiddenFieldIds: string[];
  layoutError: string | null;
  panelOpen: boolean;
  /** Unsaved changes in the view panel, and how many conditions and sorts are in effect. */
  panelStatus: { dirty: boolean; active: number; fieldIds: string };
  realtimeStatus: RealtimeStatus;
  onTogglePanel: () => void;
  /** Set for creators: opens the new-field dialog. */
  onAddField: (() => void) | null;
  /** Set for creators: the table's CSV import page. */
  importHref: string | null;
  onAddRow: () => void;
  onToggleHidden: (fieldId: string, hidden: boolean) => void;
};

const buttonClass = "rounded px-2 py-1 text-sm text-zinc-700 hover:bg-zinc-100 disabled:opacity-40 dark:text-zinc-200 dark:hover:bg-zinc-800";

/** Actions above the grid: add a record, show/hide fields, delete the selected records. */
export function GridToolbar({ store, canEdit, primaryFieldId, fields, hiddenFieldIds, layoutError, panelOpen, panelStatus, realtimeStatus, onTogglePanel, onAddField, importHref, onAddRow, onToggleHidden }: GridToolbarProps) {
  const selectedRows = useGridStore(store, (state) => state.getSelectedRowsKey());
  const pasteExtraRows = useGridStore(store, (state) => state.pastePrompt?.extraRows ?? 0);
  const [confirming, setConfirming] = useState(false);
  const [fieldsOpen, setFieldsOpen] = useState(false);
  const fieldsButton = useRef<HTMLButtonElement>(null);
  const fieldsPanel = useRef<HTMLDivElement>(null);
  useOutsidePointerDown([fieldsButton, fieldsPanel], () => setFieldsOpen(false));

  const [top, bottom] = selectedRows ? selectedRows.split(":").map(Number) : [0, -1];
  const count = bottom - top + 1;

  function deleteSelected() {
    const ids: string[] = [];
    for (let index = top; index <= bottom; index++) {
      const row = store.getRowAt(index);
      if (!row) return store.announce("Some selected rows aren't loaded yet; select fewer rows to delete them");
      ids.push(row.id);
    }
    store.deleteRows(ids);
    store.announce(`Deleting ${ids.length} ${ids.length === 1 ? "record" : "records"}`);
    setConfirming(false);
  }

  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-zinc-200 px-3 dark:border-zinc-800">
      {canEdit && (
        <button type="button" className={buttonClass} onClick={onAddRow}>
          + Add record
        </button>
      )}
      {onAddField && (
        <button type="button" className={buttonClass} onClick={onAddField}>
          + Add field
        </button>
      )}
      {importHref && (
        <Link href={importHref} className={buttonClass}>
          Import CSV
        </Link>
      )}
      <button type="button" className={`${buttonClass} ${panelOpen ? "bg-zinc-100 dark:bg-zinc-800" : ""}`} aria-expanded={panelOpen} onClick={onTogglePanel}>
        Filter &amp; sort{panelStatus.active > 0 ? ` · ${panelStatus.active}` : ""}
        {panelStatus.dirty && <span aria-label="unsaved changes" className="ml-1 inline-block size-1.5 rounded-full bg-amber-500 align-middle" />}
      </button>
      <button ref={fieldsButton} type="button" className={buttonClass} aria-haspopup="true" aria-expanded={fieldsOpen} onClick={() => setFieldsOpen((open) => !open)}>
        Fields{hiddenFieldIds.length > 0 ? ` · ${hiddenFieldIds.length} hidden` : ""}
      </button>
      {fieldsOpen && (
        <Popover anchor={fieldsButton}>
          <div ref={fieldsPanel} className="max-h-80 w-64 overflow-auto py-1">
            {fields
              .filter((field) => field.id !== primaryFieldId)
              .map((field) => (
                <label key={field.id} className="flex cursor-pointer items-center gap-2 px-3 py-1 hover:bg-zinc-50 dark:hover:bg-zinc-800">
                  <input type="checkbox" checked={!hiddenFieldIds.includes(field.id)} onChange={(event) => onToggleHidden(field.id, !event.target.checked)} />
                  <span className="truncate">{field.name}</span>
                </label>
              ))}
          </div>
        </Popover>
      )}

      {pasteExtraRows > 0 ? (
        <div role="alertdialog" aria-label="Paste past the last row" className="ml-2 flex items-center gap-2 text-sm">
          <span className="text-zinc-600 dark:text-zinc-300">The paste needs {pasteExtraRows.toLocaleString()} more {pasteExtraRows === 1 ? "row" : "rows"}.</span>
          <button type="button" autoFocus className="rounded bg-blue-600 px-2 py-1 text-white hover:bg-blue-700" onClick={() => store.pastePrompt?.answer("add")}>
            Add rows
          </button>
          <button type="button" className={buttonClass} onClick={() => store.pastePrompt?.answer("fit")}>
            Paste what fits
          </button>
          <button type="button" className={buttonClass} onClick={() => store.pastePrompt?.answer("cancel")}>
            Cancel
          </button>
        </div>
      ) : canEdit && count > 0 && (
        <div className="ml-2 flex items-center gap-2 text-sm">
          {confirming ? (
            <>
              <span className="text-zinc-600 dark:text-zinc-300">
                Delete {count.toLocaleString()} {count === 1 ? "record" : "records"}? This can&apos;t be undone.
              </span>
              <button type="button" className="rounded bg-red-600 px-2 py-1 text-white hover:bg-red-700" onClick={deleteSelected}>
                Delete
              </button>
              <button type="button" className={buttonClass} onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </>
          ) : (
            <button type="button" className={`${buttonClass} text-red-600 dark:text-red-400`} onClick={() => setConfirming(true)}>
              Delete {count.toLocaleString()} {count === 1 ? "record" : "records"}
            </button>
          )}
        </div>
      )}

      <div className="ml-auto flex items-center gap-3">
        {layoutError && (
          <span role="alert" className="text-xs text-red-600">
            {layoutError}
          </span>
        )}
        <Others store={store} />
        <ConnectionStatus store={store} realtimeStatus={realtimeStatus} />
      </div>
    </div>
  );
}

/** Avatars of the other people on this table, in their presence colour. */
function Others({ store }: { store: GridStore }) {
  const key = useGridStore(store, (state) => state.others.map((entry) => `${entry.userId}|${entry.name}|${entry.color}`).join(";"));
  if (!key) return null;
  const others = key.split(";").map((entry) => entry.split("|"));
  return (
    <ul aria-label="Also here" className="flex -space-x-1.5">
      {others.map(([userId, name, color]) => (
        <li key={userId} title={name} className="flex size-6 items-center justify-center rounded-full text-[10px] font-semibold text-white ring-2 ring-white dark:ring-zinc-950" style={{ backgroundColor: color }}>
          {name
            .split(" ")
            .map((part) => part[0])
            .join("")
            .slice(0, 2)}
        </li>
      ))}
    </ul>
  );
}

/** Live / reconnecting, and edits waiting to be sent while the server can't be reached. */
function ConnectionStatus({ store, realtimeStatus }: { store: GridStore; realtimeStatus: RealtimeStatus }) {
  const connection = useGridStore(store, (state) => state.connection);
  const unsent = useGridStore(store, (state) => state.unsentCount);
  const offline = connection === "offline";
  const live = realtimeStatus === "live" && !offline;
  return (
    <span role="status" className={`flex items-center gap-1.5 text-xs ${live ? "text-zinc-500" : "text-amber-700 dark:text-amber-400"}`}>
      <span aria-hidden className={`size-2 rounded-full ${live ? "bg-green-500" : "animate-pulse bg-amber-500"}`} />
      {offline ? `Offline · ${unsent.toLocaleString()} ${unsent === 1 ? "change" : "changes"} waiting` : realtimeStatus === "live" ? "Live" : realtimeStatus === "connecting" ? "Connecting…" : "Reconnecting…"}
    </span>
  );
}
