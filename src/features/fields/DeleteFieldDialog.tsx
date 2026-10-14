"use client";

import { useState } from "react";
import type { Field } from "@/lib/domain/field";
import { ApiRequestError } from "@/features/grid/api";
import { deleteField, type FieldDependent } from "./api";
import { dangerButtonClass, Dialog, ErrorText, secondaryButtonClass } from "./Dialog";

type DeleteFieldDialogProps = {
  tableId: string;
  field: Field;
  /** Table names, to say where a dependent field lives. */
  tableNames: Record<string, string>;
  onClose: () => void;
  onDeleted: () => void;
};

/**
 * Deleting is asked of the server first without `force`: if formulas or lookups read the
 * field, it answers 409 with them, and the dialog lists what will break and asks again.
 * Those fields then show #REF! instead of failing.
 */
export function DeleteFieldDialog({ tableId, field, tableNames, onClose, onDeleted }: DeleteFieldDialogProps) {
  const [dependents, setDependents] = useState<FieldDependent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await deleteField(tableId, field.id, dependents !== null);
      onDeleted();
    } catch (cause) {
      const listed = cause instanceof ApiRequestError && cause.status === 409 ? (cause.details as { dependents?: FieldDependent[] } | undefined)?.dependents : undefined;
      if (listed) setDependents(listed);
      else setError(cause instanceof Error ? cause.message : "Couldn't delete the field");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title={`Delete field “${field.name}”`} onClose={onClose}>
      <div className="flex flex-col gap-3 text-sm">
        {dependents ? (
          <div role="alert" className="flex flex-col gap-1">
            <p>These fields use “{field.name}” and will show an error (#REF!) until they&apos;re fixed:</p>
            <ul className="list-disc pl-5">
              {dependents.map((dependent) => (
                <li key={dependent.id}>
                  {dependent.name}
                  {dependent.tableId !== tableId && <span className="text-zinc-500"> in {tableNames[dependent.tableId] ?? dependent.tableId}</span>}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p>The field and its values in every record will be deleted. This can&apos;t be undone.</p>
        )}
        <ErrorText>{error}</ErrorText>
        <div className="flex justify-end gap-2">
          <button type="button" className={secondaryButtonClass} onClick={onClose}>
            Cancel
          </button>
          <button type="button" autoFocus className={dangerButtonClass} disabled={busy} onClick={() => void confirm()}>
            {busy ? "Deleting…" : dependents ? "Delete anyway" : "Delete field"}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
