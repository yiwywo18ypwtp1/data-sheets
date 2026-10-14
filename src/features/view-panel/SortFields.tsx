import { useState } from "react";
import { useFieldArray, useFormContext, useWatch } from "react-hook-form";
import type { Field } from "@/lib/domain/field";
import { isSortable, type ViewQuery } from "@/lib/domain/view";
import { controlClass, smallButtonClass } from "./inputs";

const MAX_SORTS = 10;

/**
 * Sort levels in priority order. Reordering: drag a row by its handle, or use the ↑/↓
 * buttons from the keyboard;
 * a field already used by another level isn't offered again, so there are no duplicates.
 */
export function SortFields({ fields }: { fields: Field[] }) {
  const { control, register, formState } = useFormContext<ViewQuery>();
  const { fields: rows, append, remove, swap, move } = useFieldArray({ control, name: "sorts" });
  const [dragged, setDragged] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const sorts = useWatch({ control, name: "sorts" });
  const sortable = fields.filter(isSortable);
  const used = new Set(sorts.map((sort) => sort.fieldId));
  const nextField = sortable.find((field) => !used.has(field.id));

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-sm font-semibold">Sort</legend>
      <ol className="flex flex-col gap-1.5">
        {rows.map((row, index) => {
          const name = fields.find((field) => field.id === sorts[index]?.fieldId)?.name ?? "Deleted field";
          const error = formState.errors.sorts?.[index]?.fieldId?.message;
          return (
            <li
              key={row.id}
              className={`flex flex-col gap-0.5 rounded ${over === index && dragged !== null && dragged !== index ? "bg-blue-50 dark:bg-blue-950" : ""} ${dragged === index ? "opacity-50" : ""}`}
              onDragOver={(event) => {
                if (dragged === null) return;
                event.preventDefault();
                setOver(index);
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (dragged !== null && dragged !== index) move(dragged, index);
                setDragged(null);
                setOver(null);
              }}
            >
              <div className="flex items-center gap-1.5">
                <span
                  draggable
                  aria-hidden
                  title="Drag to reorder"
                  className="cursor-grab px-0.5 text-zinc-400 select-none active:cursor-grabbing"
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", String(index));
                    setDragged(index);
                  }}
                  onDragEnd={() => {
                    setDragged(null);
                    setOver(null);
                  }}
                >
                  ⠿
                </span>
                <span className="w-12 text-sm text-zinc-500">{index === 0 ? "Sort by" : "then by"}</span>
                <select aria-label={`Sort field ${index + 1}`} className={controlClass} {...register(`sorts.${index}.fieldId`)}>
                  {!sortable.some((field) => field.id === sorts[index]?.fieldId) && <option value={sorts[index]?.fieldId}>{name}</option>}
                  {sortable.map((field) => (
                    <option key={field.id} value={field.id} disabled={used.has(field.id) && field.id !== sorts[index]?.fieldId}>
                      {field.name}
                    </option>
                  ))}
                </select>
                <select aria-label={`Direction for ${name}`} className={controlClass} {...register(`sorts.${index}.direction`)}>
                  <option value="asc">Ascending</option>
                  <option value="desc">Descending</option>
                </select>
                <button type="button" aria-label={`Move ${name} up`} className={smallButtonClass} disabled={index === 0} onClick={() => swap(index, index - 1)}>
                  ↑
                </button>
                <button type="button" aria-label={`Move ${name} down`} className={smallButtonClass} disabled={index === rows.length - 1} onClick={() => swap(index, index + 1)}>
                  ↓
                </button>
                <button type="button" aria-label={`Remove sort by ${name}`} className={smallButtonClass} onClick={() => remove(index)}>
                  ×
                </button>
              </div>
              {error && (
                <span role="alert" className="text-xs text-red-600">
                  {error}
                </span>
              )}
            </li>
          );
        })}
      </ol>
      {(formState.errors.sorts?.root?.message ?? formState.errors.sorts?.message) && (
        <span role="alert" className="text-xs text-red-600">
          {formState.errors.sorts?.root?.message ?? formState.errors.sorts?.message}
        </span>
      )}
      <button
        type="button"
        className={`${smallButtonClass} self-start`}
        disabled={!nextField || rows.length >= MAX_SORTS}
        onClick={() => nextField && append({ fieldId: nextField.id, direction: "asc" })}
      >
        + Add sort
      </button>
    </fieldset>
  );
}
