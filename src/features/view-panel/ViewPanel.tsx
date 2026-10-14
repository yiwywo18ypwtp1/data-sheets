"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useMemo, useState } from "react";
import { FormProvider, useForm, useWatch } from "react-hook-form";
import type { Field } from "@/lib/domain/field";
import { isConditionComplete } from "@/lib/domain/filter";
import { viewQuerySchemaFor, type View, type ViewQuery } from "@/lib/domain/view";
import { ApiRequestError } from "@/features/grid/api";
import { FilterFields, type FilterContext } from "./FilterFields";
import { smallButtonClass } from "./inputs";
import { SortFields } from "./SortFields";

/** Typing in a condition waits this long before the grid refetches. */
export const APPLY_DELAY_MS = 300;

type ViewPanelProps = {
  open: boolean;
  fields: Field[];
  /** The view as saved on the server: what Reset goes back to and what "unsaved" compares with. */
  saved: View;
  /** Null for viewers: they can filter for themselves, but not save the view. */
  save: ((patch: Partial<View>) => Promise<View>) | null;
  /** Called with a valid filter and sort, debounced, so the grid shows them before they're saved. */
  onApply: (query: ViewQuery) => void;
  onStatusChange: (status: { dirty: boolean; active: number }) => void;
  labelOf: FilterContext["labelOf"];
};

const pick = (view: View): ViewQuery => ({ filter: view.filter, sorts: view.sorts });

/** Conditions and sorts that actually affect the grid, for the toolbar button. */
function activeCount(query: ViewQuery): number {
  const conditions = [...query.filter.conditions, ...query.filter.groups.flatMap((group) => group.conditions)];
  return conditions.filter(isConditionComplete).length + query.sorts.length;
}

/**
 * The view panel: one React Hook Form for the view's filter tree and sorts, validated
 * with the same schema the server uses on save. Valid changes reach the grid after a
 * short debounce; the view is saved only with "Save view", until then the panel shows
 * that there are unsaved changes and can reset to the saved view.
 *
 * The panel stays mounted while closed (just hidden), so a draft survives closing it.
 */
export function ViewPanel({ open, fields, saved, save, onApply, onStatusChange, labelOf }: ViewPanelProps) {
  const schema = useMemo(() => viewQuerySchemaFor(fields), [fields]);
  const form = useForm<ViewQuery>({ resolver: zodResolver(schema), defaultValues: pick(saved), mode: "onChange" });
  const [saveError, setSaveError] = useState<string | null>(null);
  const values = useWatch({ control: form.control });
  const valuesKey = JSON.stringify(values);
  const { isDirty, isSubmitting } = form.formState;

  useEffect(() => {
    const timer = setTimeout(() => {
      const parsed = schema.safeParse(form.getValues());
      if (parsed.success) onApply(parsed.data);
    }, APPLY_DELAY_MS);
    return () => clearTimeout(timer);
  }, [valuesKey, schema, form, onApply]);

  const active = activeCount(form.getValues());
  useEffect(() => onStatusChange({ dirty: isDirty, active }), [isDirty, active, onStatusChange]);

  const submit = form.handleSubmit(async (query) => {
    if (!save) return;
    try {
      const view = await save(query);
      form.reset(pick(view));
      setSaveError(null);
    } catch (error) {
      setSaveError(error instanceof ApiRequestError ? `Couldn't save the view: ${error.message}` : "Couldn't save the view");
    }
  });

  const actions = (
    <div className="flex items-center gap-2">
      {isDirty && <span className="text-xs text-amber-700 dark:text-amber-400">Unsaved view changes</span>}
      {saveError && (
        <span role="alert" className="text-xs text-red-600">
          {saveError}
        </span>
      )}
      <button type="button" className={smallButtonClass} disabled={!isDirty} onClick={() => form.reset(pick(saved))}>
        Reset
      </button>
      {save ? (
        <button type="submit" disabled={!isDirty || isSubmitting} className="rounded bg-blue-600 px-2 py-1 text-sm text-white hover:bg-blue-700 disabled:opacity-40">
          {isSubmitting ? "Saving…" : "Save view"}
        </button>
      ) : (
        <span className="text-xs text-zinc-500">Viewers can filter for themselves but can&apos;t save views</span>
      )}
    </div>
  );

  if (!open && !isDirty) return null;
  return (
    <FormProvider {...form}>
      <form
        aria-label="View settings"
        onSubmit={(event) => void submit(event)}
        className="flex shrink-0 flex-col gap-3 border-b border-zinc-200 px-3 py-2 dark:border-zinc-800"
      >
        <div hidden={!open} className="flex max-h-[45vh] flex-wrap gap-x-10 gap-y-4 overflow-auto">
          <FilterFields context={{ fields, labelOf }} />
          <SortFields fields={fields} />
        </div>
        {actions}
      </form>
    </FormProvider>
  );
}
