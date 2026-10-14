import { z } from "zod";
import { createCoercer } from "@/lib/coerce/coerce";
import type { CellValue } from "./cell";
import type { Field } from "./field";
import { idSchema } from "./ids";

/**
 * A form view: which fields a public form asks for, in what order, which are required,
 * with what hint, and when a question is shown (conditional visibility). The same
 * runtime zod schema of the answers is used by the public page and by the Server Action.
 */

/** Show a question only when another (earlier) question's answer is one of `values`: option ids, or "true" for a checkbox. */
export const showIfSchema = z.object({ fieldId: idSchema, values: z.array(z.string().max(100)).min(1, "Pick at least one answer").max(50) });

export const formFieldSchema = z.object({
  fieldId: idSchema,
  required: z.boolean(),
  hint: z.string().trim().max(500).optional(),
  showIf: showIfSchema.optional(),
});
export type FormField = z.infer<typeof formFieldSchema>;

export const formConfigSchema = z.object({
  title: z.string().trim().max(200),
  description: z.string().trim().max(2000),
  fields: z.array(formFieldSchema).max(100),
  submitLabel: z.string().trim().min(1).max(50),
  successMessage: z.string().trim().max(500),
});
export type FormConfig = z.infer<typeof formConfigSchema>;

/** Field types a public form can ask for. Links, lookups and formulas aren't questions. */
export function isFormFieldType(field: Field): boolean {
  return field.type !== "link" && field.type !== "lookup" && field.type !== "formula";
}

/** Fields whose answer can control another question's visibility. */
export function canControlVisibility(field: Field): boolean {
  return field.type === "checkbox" || field.type === "singleSelect" || field.type === "multiSelect";
}

/** A form's questions with their fields, in form order; questions whose field is gone or unsupported are dropped. */
export function formQuestions(config: FormConfig, fields: Field[]): (FormField & { field: Field })[] {
  const byId = new Map(fields.map((field) => [field.id, field]));
  return config.fields.flatMap((question) => {
    const field = byId.get(question.fieldId);
    return field && isFormFieldType(field) ? [{ ...question, field }] : [];
  });
}

/** Raw answers as the form holds them: text for inputs, a boolean for a checkbox, option ids for selects. */
/** Null: a radio group with nothing picked (what React Hook Form reports). */
export type RawAnswer = string | boolean | string[] | null | undefined;
export type RawAnswers = Record<string, RawAnswer>;

function answerKeys(answer: RawAnswer): string[] {
  if (answer === true) return ["true"];
  if (Array.isArray(answer)) return answer;
  return typeof answer === "string" && answer !== "" ? [answer] : [];
}

/** The questions shown for these answers: a question with `showIf` needs its controlling question shown and answered as listed. */
export function visibleQuestions(config: FormConfig, fields: Field[], answers: RawAnswers): (FormField & { field: Field })[] {
  const shown = new Set<string>();
  return formQuestions(config, fields).filter((question) => {
    const rule = question.showIf;
    const visible = !rule || (shown.has(rule.fieldId) && answerKeys(answers[rule.fieldId]).some((key) => rule.values.includes(key)));
    if (visible) shown.add(question.fieldId);
    return visible;
  });
}

const isEmpty = (answer: RawAnswer) => answer === undefined || answer === null || answer === "" || answer === false || (Array.isArray(answer) && answer.length === 0);

/**
 * The answers' schema for a form, built at runtime from its questions and the fields'
 * types: hidden questions are ignored, required ones must be answered, and each answer
 * is converted with the same coercer as the grid's editors (so "1 234,5" works in uk-UA).
 * Output: the cell values to create the record with.
 */
export function formAnswersSchema(config: FormConfig, fields: Field[], options: { locale: string; timeZone: string }) {
  const coercers = new Map(formQuestions(config, fields).map((question) => [question.fieldId, createCoercer(question.field, options)]));
  return z.record(z.string(), z.union([z.string().max(100_000), z.boolean(), z.array(z.string().max(100)).max(200), z.null()]).optional()).transform((answers, ctx) => {
    const values: Record<string, CellValue> = {};
    for (const question of visibleQuestions(config, fields, answers)) {
      const answer = answers[question.fieldId];
      if (isEmpty(answer)) {
        if (question.required) ctx.addIssue({ code: "custom", path: [question.fieldId], message: "This question is required" });
        continue;
      }
      const field = question.field;
      if (field.type === "checkbox") {
        values[field.id] = answer === true;
      } else if (field.type === "multiSelect" || field.type === "singleSelect") {
        const ids = answerKeys(answer);
        const known = new Set(field.options.map((option) => option.id));
        if (ids.some((id) => !known.has(id))) ctx.addIssue({ code: "custom", path: [question.fieldId], message: "Unknown option" });
        else values[field.id] = field.type === "multiSelect" ? ids : ids[0];
      } else {
        const result = coercers.get(field.id)!(String(answer));
        if (result.ok) values[field.id] = result.value;
        else ctx.addIssue({ code: "custom", path: [question.fieldId], message: result.error });
      }
    }
    return values;
  });
}

/**
 * Identifies what a guest is answering: the form's settings and its fields' definitions.
 * The server refuses an answer to an older version, so a schema change while a guest
 * fills the form is noticed instead of saving answers to questions that changed.
 */
export function formVersion(config: FormConfig, fields: Field[]): string {
  const text = JSON.stringify([config, formQuestions(config, fields).map((question) => question.field)]);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return (hash >>> 0).toString(36);
}

/** A new form: the table's first few askable fields, none required. */
export function defaultFormConfig(tableName: string, fields: Field[]): FormConfig {
  return {
    title: tableName,
    description: "",
    fields: fields.filter(isFormFieldType).slice(0, 6).map((field) => ({ fieldId: field.id, required: false })),
    submitLabel: "Submit",
    successMessage: "Thank you! Your answer was recorded.",
  };
}

/**
 * Rules of a form's settings that need the table: questions are fields that exist and can
 * be asked, each once; a condition refers to an earlier question whose answer it can
 * test, with answers that exist. Used by the form builder and by the server on save.
 */
export function formConfigIssues(config: FormConfig, fields: Field[]): { path: (string | number)[]; message: string }[] {
  const byId = new Map(fields.map((field) => [field.id, field]));
  const issues: { path: (string | number)[]; message: string }[] = [];
  const seen = new Set<string>();
  config.fields.forEach((question, index) => {
    const field = byId.get(question.fieldId);
    if (!field) issues.push({ path: ["fields", index, "fieldId"], message: "Field no longer exists" });
    else if (!isFormFieldType(field)) issues.push({ path: ["fields", index, "fieldId"], message: "This field can't be a question" });
    else if (seen.has(field.id)) issues.push({ path: ["fields", index, "fieldId"], message: "This field is already a question" });
    const rule = question.showIf;
    if (rule) {
      const source = byId.get(rule.fieldId);
      if (!seen.has(rule.fieldId) || !source || !canControlVisibility(source)) {
        issues.push({ path: ["fields", index, "showIf", "fieldId"], message: "Pick an earlier checkbox or select question" });
      } else {
        const allowed = source.type === "checkbox" ? ["true"] : "options" in source ? source.options.map((option) => option.id) : [];
        if (rule.values.some((value) => !allowed.includes(value))) issues.push({ path: ["fields", index, "showIf", "values"], message: "Unknown answer" });
      }
    }
    seen.add(question.fieldId);
  });
  return issues;
}
