import { useFieldArray, useFormContext, useWatch } from "react-hook-form";
import type { Field } from "@/lib/domain/field";
import { isSortable, type ViewQuery } from "@/lib/domain/view";
import { controlClass, smallButtonClass } from "./inputs";

const MAX_LEVELS = 2;

/** Grouping: up to two fields, each used once. Groups are ordered like a sort on that field. */
export function GroupFields({ fields }: { fields: Field[] }) {
  const { control, register, formState } = useFormContext<ViewQuery>();
  const { fields: rows, append, remove } = useFieldArray({ control, name: "groupBy" });
  const groupBy = useWatch({ control, name: "groupBy" }) ?? [];
  const groupable = fields.filter(isSortable);
  const used = new Set(groupBy.map((group) => group.fieldId));
  const next = groupable.find((field) => !used.has(field.id));

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-sm font-semibold">Group</legend>
      {rows.map((row, index) => {
        const error = formState.errors.groupBy?.[index]?.fieldId?.message;
        return (
          <div key={row.id} className="flex flex-col gap-0.5">
            <div className="flex items-center gap-1.5">
              <span className="w-12 text-sm text-zinc-500">{index === 0 ? "Group by" : "then by"}</span>
              <select aria-label={`Group level ${index + 1}`} className={controlClass} {...register(`groupBy.${index}.fieldId`)}>
                {!groupable.some((field) => field.id === groupBy[index]?.fieldId) && <option value={groupBy[index]?.fieldId}>Deleted field</option>}
                {groupable.map((field) => (
                  <option key={field.id} value={field.id} disabled={used.has(field.id) && field.id !== groupBy[index]?.fieldId}>
                    {field.name}
                  </option>
                ))}
              </select>
              <button type="button" aria-label={`Remove group level ${index + 1}`} className={smallButtonClass} onClick={() => remove(index)}>
                ×
              </button>
            </div>
            {error && (
              <span role="alert" className="text-xs text-red-600">
                {error}
              </span>
            )}
          </div>
        );
      })}
      <button type="button" className={`${smallButtonClass} self-start`} disabled={!next || rows.length >= MAX_LEVELS} onClick={() => next && append({ fieldId: next.id })}>
        + Add group
      </button>
    </fieldset>
  );
}
