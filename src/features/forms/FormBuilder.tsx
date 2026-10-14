"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useMemo, useState } from "react";
import { useFieldArray, useForm, type UseFormReturn } from "react-hook-form";
import type { Field } from "@/lib/domain/field";
import { canControlVisibility, defaultFormConfig, formConfigIssues, formConfigSchema, isFormFieldType, type FormConfig } from "@/lib/domain/form";
import type { View } from "@/lib/domain/view";
import { ApiRequestError } from "@/features/grid/api";
import { useSavedView } from "@/features/grid/useSavedView";

const inputClass = "h-8 w-full rounded border border-zinc-300 bg-white px-2 text-sm dark:border-zinc-700 dark:bg-zinc-900 aria-invalid:border-red-500";
const smallButton = "rounded px-2 py-1 text-sm text-zinc-600 hover:bg-zinc-100 disabled:opacity-40 dark:text-zinc-300 dark:hover:bg-zinc-800";

/**
 * Every question with an explicit hint (empty when none): the hint input always holds a
 * string, and a key that's missing in the saved form but present in the form state would
 * make it look edited right after a save.
 */
const editable = (config: FormConfig): FormConfig => ({ ...config, fields: config.fields.map((question) => ({ ...question, hint: question.hint ?? "" })) });

type FormBuilderProps = { view: View; version: number; fields: Field[]; tableName: string; canEdit: boolean; publicHref: string };

/**
 * Settings of a form view: its texts and questions (order, required, hint, and "show only
 * if" an earlier answer is one of some values). One React Hook Form over the form config,
 * validated with the same rules the server applies on save. Saved with If-Match like any
 * view; the public page's cache is expired by the save.
 */
export function FormBuilder({ view, version, fields, tableName, canEdit, publicHref }: FormBuilderProps) {
  const saved = useSavedView(view, version);
  const schema = useMemo(
    () =>
      formConfigSchema.superRefine((config, ctx) => {
        for (const issue of formConfigIssues(config, fields)) ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
      }),
    [fields],
  );
  const form = useForm<FormConfig>({ resolver: zodResolver(schema), defaultValues: editable(saved.view.form ?? defaultFormConfig(tableName, fields)) });
  const questions = useFieldArray({ control: form.control, name: "fields" });
  // `watch()`, not `useWatch`: it reads the values as they are in this render, so right after a
  // move the rows' names and conditions already match their new positions.
  const values = form.watch();
  const [copied, setCopied] = useState(false);
  const { errors, isDirty, isSubmitting } = form.formState;
  const askable = fields.filter(isFormFieldType);
  const unused = askable.filter((field) => !values.fields?.some((question) => question.fieldId === field.id));

  const submit = form.handleSubmit(async (config) => {
    try {
      const next = await saved.save({ form: config });
      if (next.form) form.reset(editable(next.form));
    } catch (error) {
      form.setError("root", { message: error instanceof ApiRequestError ? error.message : "Couldn't save the form" });
    }
  });

  return (
    <form noValidate onSubmit={(event) => void submit(event)} className="mx-auto flex w-full max-w-3xl flex-col gap-4 overflow-auto p-6">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold">Form settings</h1>
        <a href={publicHref} target="_blank" rel="noreferrer" className="ml-auto text-sm text-blue-600 hover:underline">
          Open the form ↗
        </a>
        <button
          type="button"
          className={smallButton}
          onClick={() => void navigator.clipboard.writeText(new URL(publicHref, window.location.href).href).then(() => setCopied(true))}
          onBlur={() => setCopied(false)}
        >
          {copied ? "Link copied" : "Copy link"}
        </button>
      </div>
      <fieldset disabled={!canEdit} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm">
          Title
          <input className={inputClass} {...form.register("title")} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Description
          <textarea rows={2} className={`${inputClass} h-auto py-1.5`} {...form.register("description")} />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1 text-sm">
            Button
            <input className={inputClass} aria-invalid={errors.submitLabel ? true : undefined} {...form.register("submitLabel")} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            After sending
            <input className={inputClass} {...form.register("successMessage")} />
          </label>
        </div>

        <h2 className="mt-2 text-sm font-semibold">Questions</h2>
        <ol className="flex flex-col gap-2">
          {questions.fields.map((row, index) => (
            <QuestionSettings key={row.id} index={index} form={form} fields={fields} values={values} count={questions.fields.length} onMove={(to) => questions.swap(index, to)} onRemove={() => questions.remove(index)} />
          ))}
        </ol>
        {questions.fields.length === 0 && <p className="text-sm text-zinc-500">No questions yet.</p>}
        <select
          aria-label="Add a question"
          className={`${inputClass} w-64`}
          value=""
          disabled={unused.length === 0}
          onChange={(event) => event.target.value && questions.append({ fieldId: event.target.value, required: false })}
        >
          <option value="">+ Add a question…</option>
          {unused.map((field) => (
            <option key={field.id} value={field.id}>
              {field.name}
            </option>
          ))}
        </select>
      </fieldset>

      {errors.root?.message && (
        <p role="alert" className="text-sm text-red-600">
          {errors.root.message}
        </p>
      )}
      {canEdit ? (
        <div className="flex items-center gap-2">
          {isDirty && <span className="text-xs text-amber-700 dark:text-amber-400">Unsaved changes</span>}
          <button type="button" className={smallButton} disabled={!isDirty} onClick={() => saved.view.form && form.reset(editable(saved.view.form))}>
            Reset
          </button>
          <button type="submit" disabled={!isDirty || isSubmitting} className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-40">
            {isSubmitting ? "Saving…" : "Save form"}
          </button>
        </div>
      ) : (
        <p className="text-xs text-zinc-500">Viewers can&apos;t change forms.</p>
      )}
    </form>
  );
}

type QuestionProps = {
  index: number;
  form: UseFormReturn<FormConfig>;
  fields: Field[];
  values: FormConfig;
  count: number;
  onMove: (to: number) => void;
  onRemove: () => void;
};

function QuestionSettings({ index, form, fields, values, count, onMove, onRemove }: QuestionProps) {
  const question = values.fields?.[index];
  const field = fields.find((candidate) => candidate.id === question?.fieldId);
  const name = field?.name ?? "Deleted field";
  // A condition can only depend on an earlier checkbox or select question.
  const earlier = (values.fields ?? []).slice(0, index).flatMap((other) => {
    const source = fields.find((candidate) => candidate.id === other.fieldId);
    return source && canControlVisibility(source) ? [source] : [];
  });
  const source = fields.find((candidate) => candidate.id === question?.showIf?.fieldId);
  const answers = source?.type === "checkbox" ? [{ id: "true", label: "Checked" }] : source && "options" in source ? source.options : [];
  const rowErrors = form.formState.errors.fields?.[index];
  const error = rowErrors?.fieldId?.message ?? rowErrors?.showIf?.fieldId?.message ?? rowErrors?.showIf?.values?.message ?? rowErrors?.showIf?.message;

  const setCondition = (next: FormConfig["fields"][number]["showIf"]) => {
    form.setValue(`fields.${index}.showIf`, next, { shouldDirty: true });
    // Nothing under showIf is a registered input; RHF only keeps such nested errors when the whole form is validated.
    if (form.formState.isSubmitted) void form.trigger();
  };

  return (
    <li className="flex flex-col gap-2 rounded border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="flex items-center gap-2">
        <span className="font-medium">{name}</span>
        <span className="text-xs text-zinc-500">{field?.type}</span>
        <label className="ml-auto flex items-center gap-1.5 text-sm">
          <input type="checkbox" {...form.register(`fields.${index}.required`)} />
          Required
        </label>
        <button type="button" aria-label={`Move ${name} up`} className={smallButton} disabled={index === 0} onClick={() => onMove(index - 1)}>
          ↑
        </button>
        <button type="button" aria-label={`Move ${name} down`} className={smallButton} disabled={index === count - 1} onClick={() => onMove(index + 1)}>
          ↓
        </button>
        <button type="button" aria-label={`Remove ${name}`} className={smallButton} onClick={onRemove}>
          ×
        </button>
      </div>
      <input aria-label={`Hint for ${name}`} placeholder="Hint (optional)" className={inputClass} {...form.register(`fields.${index}.hint`)} />
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <label className="flex items-center gap-1.5">
          Show
          <select
            aria-label={`When to show ${name}`}
            className={`${inputClass} w-56`}
            value={question?.showIf?.fieldId ?? ""}
            onChange={(event) => setCondition(event.target.value ? { fieldId: event.target.value, values: [] } : undefined)}
          >
            <option value="">always</option>
            {question?.showIf && !earlier.some((candidate) => candidate.id === question.showIf!.fieldId) && <option value={question.showIf.fieldId}>if a removed question…</option>}
            {earlier.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                only if “{candidate.name}” is
              </option>
            ))}
          </select>
        </label>
        {question?.showIf &&
          answers.map((answer) => {
            const on = question.showIf!.values.includes(answer.id);
            return (
              <button
                key={answer.id}
                type="button"
                aria-pressed={on}
                className={`rounded-full border px-2 text-xs leading-5 ${on ? "border-blue-600 bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300" : "border-zinc-300 text-zinc-500 dark:border-zinc-700"}`}
                onClick={() => setCondition({ ...question.showIf!, values: on ? question.showIf!.values.filter((value) => value !== answer.id) : [...question.showIf!.values, answer.id] })}
              >
                {answer.label}
              </button>
            );
          })}
      </div>
      {error && (
        <span role="alert" className="text-xs text-red-600">
          {error}
        </span>
      )}
    </li>
  );
}
