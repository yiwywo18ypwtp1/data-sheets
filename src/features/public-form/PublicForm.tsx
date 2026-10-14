"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { useForm, useWatch, type UseFormRegister } from "react-hook-form";
import type { CellValue } from "@/lib/domain/cell";
import type { Field } from "@/lib/domain/field";
import { formAnswersSchema, visibleQuestions, type FormConfig, type RawAnswers } from "@/lib/domain/form";
import { newId } from "@/lib/domain/ids";
import { useViewerLocale } from "@/features/grid/useViewerLocale";
import type { FormDefinition } from "@/server/forms";
import { submitFormAction } from "./actions";

const inputClass = "h-9 w-full rounded border border-zinc-300 bg-white px-2 text-sm dark:border-zinc-700 dark:bg-zinc-900 aria-invalid:border-red-500";

/** The answers plus the honeypot, which isn't a question. */
type FormValues = RawAnswers & { website?: string };

/**
 * The guest's side of a form view. The answers are checked with the same runtime zod
 * schema the server uses (built from the questions and the fields' types), questions
 * appear and disappear with the answers they depend on, and a submission carries an id
 * chosen when the form opens, so a double click or a retry creates one record.
 */
export function PublicForm({ definition }: { definition: FormDefinition }) {
  const router = useRouter();
  const { locale, timeZone } = useViewerLocale();
  const [submissionId, setSubmissionId] = useState(() => newId("sub"));
  const [done, setDone] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const config: FormConfig = useMemo(
    () => ({
      title: definition.title,
      description: definition.description,
      submitLabel: definition.submitLabel,
      successMessage: definition.successMessage,
      fields: definition.questions.map((question) => ({ fieldId: question.fieldId, required: question.required, hint: question.hint, showIf: question.showIf })),
    }),
    [definition],
  );
  const fields = useMemo(() => definition.questions.map((question) => question.field), [definition]);
  const schema = useMemo(() => formAnswersSchema(config, fields, { locale, timeZone }), [config, fields, locale, timeZone]);
  const form = useForm<FormValues, unknown, Record<string, CellValue>>({ resolver: zodResolver(schema), defaultValues: {} });
  const answers = useWatch({ control: form.control }) as FormValues;
  const visible = visibleQuestions(config, fields, answers);
  const { errors, isSubmitting } = form.formState;

  const submit = form.handleSubmit(async () => {
    setNotice(null);
    const { website, ...raw } = form.getValues();
    const result = await submitFormAction(definition.viewId, { submissionId, version: definition.version, answers: raw, locale, timeZone, website });
    if (result.ok) return setDone(result.message);
    if (result.code === "CHANGED") {
      // Load the new form; answers to questions that still exist are kept.
      setNotice(result.message);
      router.refresh();
      return;
    }
    for (const [fieldId, message] of Object.entries(result.fieldErrors ?? {})) form.setError(fieldId, { message });
    form.setError("root", { message: result.message });
  });

  if (done) {
    return (
      <section className="space-y-4 rounded-lg border border-zinc-200 p-6 dark:border-zinc-800">
        <h1 className="text-xl font-semibold">{definition.title}</h1>
        <p role="status">{done}</p>
        <button
          type="button"
          className="text-sm text-blue-600 hover:underline"
          onClick={() => {
            form.reset({});
            setSubmissionId(newId("sub"));
            setDone(null);
          }}
        >
          Send another answer
        </button>
      </section>
    );
  }

  return (
    <form noValidate onSubmit={(event) => void submit(event)} className="space-y-5 rounded-lg border border-zinc-200 p-6 dark:border-zinc-800">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">{definition.title}</h1>
        {definition.description && <p className="text-sm whitespace-pre-line text-zinc-600 dark:text-zinc-400">{definition.description}</p>}
      </header>
      {notice && (
        <p role="alert" className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm dark:border-amber-700 dark:bg-amber-950">
          {notice}
        </p>
      )}

      {visible.map((question) => (
        <Question key={question.fieldId} field={question.field} required={question.required} hint={question.hint} error={errors[question.fieldId]?.message} register={form.register} />
      ))}

      {/* Honeypot: hidden from people (and from assistive tech); bots that fill every input fill it. */}
      <div aria-hidden className="absolute -left-[10000px] h-px w-px overflow-hidden">
        <label>
          Website
          <input tabIndex={-1} autoComplete="off" {...form.register("website")} />
        </label>
      </div>

      {errors.root?.message && (
        <p role="alert" className="text-sm text-red-600">
          {errors.root.message}
        </p>
      )}
      <button type="submit" disabled={isSubmitting} className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
        {isSubmitting ? "Sending…" : definition.submitLabel}
      </button>
    </form>
  );
}

function Question({ field, required, hint, error, register }: { field: Field; required: boolean; hint?: string; error?: string; register: UseFormRegister<FormValues> }) {
  const id = `q-${field.id}`;
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;
  const label = (
    <>
      {field.name}
      {required && (
        <span aria-hidden className="text-red-600">
          {" "}
          *
        </span>
      )}
    </>
  );
  const common = { "aria-invalid": error ? true : undefined, "aria-describedby": describedBy, "aria-required": required || undefined };

  let control: React.ReactNode;
  if (field.type === "checkbox") {
    control = (
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" {...common} {...register(field.id)} />
        {label}
      </label>
    );
  } else if (field.type === "singleSelect" || field.type === "multiSelect") {
    control = (
      <fieldset {...common}>
        <legend className="mb-1 text-sm font-medium">{label}</legend>
        <div className="flex flex-col gap-1">
          {field.options.map((option) => (
            <label key={option.id} className="flex items-center gap-2 text-sm">
              <input type={field.type === "singleSelect" ? "radio" : "checkbox"} value={option.id} {...register(field.id)} />
              {option.label}
            </label>
          ))}
        </div>
      </fieldset>
    );
  } else {
    const type = field.type === "email" ? "email" : field.type === "url" ? "url" : field.type === "date" ? (field.includeTime ? "datetime-local" : "date") : "text";
    const numeric = field.type === "number" || field.type === "currency";
    control = (
      <label className="flex flex-col gap-1 text-sm font-medium">
        <span>
          {label}
          {field.type === "currency" && <span className="font-normal text-zinc-500"> ({field.currency})</span>}
        </span>
        <input id={id} type={type} inputMode={numeric ? "decimal" : undefined} className={inputClass} {...common} {...register(field.id)} />
      </label>
    );
  }

  return (
    <div className="space-y-1">
      {control}
      {hint && (
        <p id={`${id}-hint`} className="text-xs text-zinc-500">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} role="alert" className="text-xs text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
