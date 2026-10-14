import { useRef, useState } from "react";
import type { Field } from "@/lib/domain/field";
import { Popover } from "./editors/Popover";
import { useOutsidePointerDown } from "./editors/useOutsidePointerDown";
import type { GridStore } from "./GridStore";
import { useGridStore } from "./useGridStore";

type GridToolbarProps = {
  store: GridStore;
  canEdit: boolean;
  primaryFieldId: string;
  fields: Field[];
  hiddenFieldIds: string[];
  layoutError: string | null;
  onAddRow: () => void;
  onToggleHidden: (fieldId: string, hidden: boolean) => void;
};

const buttonClass = "rounded px-2 py-1 text-sm text-zinc-700 hover:bg-zinc-100 disabled:opacity-40 dark:text-zinc-200 dark:hover:bg-zinc-800";

/** Actions above the grid: add a record, show/hide fields, delete the selected records. */
export function GridToolbar({ store, canEdit, primaryFieldId, fields, hiddenFieldIds, layoutError, onAddRow, onToggleHidden }: GridToolbarProps) {
  const selectedRows = useGridStore(store, (state) => state.getSelectedRowsKey());
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

      {canEdit && count > 0 && (
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

      {layoutError && (
        <span role="alert" className="ml-auto text-xs text-red-600">
          {layoutError}
        </span>
      )}
    </div>
  );
}
