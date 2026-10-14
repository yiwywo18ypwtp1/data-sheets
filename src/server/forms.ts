import "server-only";
import { cacheTag } from "next/cache";
import { z } from "zod";
import { isValidTimeZone, type Field } from "@/lib/domain/field";
import { formAnswersSchema, formQuestions, formVersion, type FormField } from "@/lib/domain/form";
import { idSchema, newId } from "@/lib/domain/ids";
import { now } from "./clock";
import { getDb } from "./db";
import { zodFieldErrors } from "./errors";
import { formTags } from "./formCache";
import { applyRowBatch } from "./rowWrites";
import { getTable, getView } from "./tables";

/** What the public page needs to render a form: its texts and questions, and the version it was built from. */
export type FormDefinition = {
  viewId: string;
  title: string;
  description: string;
  submitLabel: string;
  successMessage: string;
  questions: (FormField & { field: Field })[];
  version: string;
};

/** The form of a form view, read now (null if the view doesn't exist or isn't a form). */
export function formDefinition(viewId: string): (FormDefinition & { tableId: string }) | null {
  const found = getView(viewId);
  if (!found || found.view.kind !== "form" || !found.view.form) return null;
  const table = getTable(found.tableId);
  if (!table) return null;
  const config = found.view.form;
  return {
    viewId,
    tableId: table.id,
    title: config.title || found.view.name,
    description: config.description,
    submitLabel: config.submitLabel,
    successMessage: config.successMessage,
    questions: formQuestions(config, table.fields),
    version: formVersion(config, table.fields),
  };
}

/**
 * The same, cached for the public page (it's static between changes): tagged with the
 * view and its table, whose changes expire it (formCache.ts).
 */
export async function cachedFormDefinition(viewId: string): Promise<FormDefinition | null> {
  "use cache";
  cacheTag(formTags.view(viewId));
  const definition = formDefinition(viewId);
  if (!definition) return null;
  cacheTag(formTags.table(definition.tableId));
  return {
    viewId: definition.viewId,
    title: definition.title,
    description: definition.description,
    submitLabel: definition.submitLabel,
    successMessage: definition.successMessage,
    questions: definition.questions,
    version: definition.version,
  };
}

const isValidLocale = (locale: string) => {
  try {
    return Intl.NumberFormat.supportedLocalesOf(locale).length > 0;
  } catch {
    return false;
  }
};

export const submissionSchema = z.object({
  /** Generated when the guest opens the form: a repeated submit (double click, retry) creates one record. */
  submissionId: idSchema,
  /** The form version the guest answered; a different current version means the form changed meanwhile. */
  version: z.string().max(20),
  answers: z.record(z.string(), z.unknown()),
  locale: z.string().max(35).refine(isValidLocale).catch("en-US"),
  timeZone: z.string().max(64).refine(isValidTimeZone).catch("UTC"),
  /** The honeypot: a field people don't see. Bots fill it. */
  website: z.string().max(500).optional(),
});
export type Submission = z.input<typeof submissionSchema>;

export type SubmitResult =
  | { ok: true; message: string }
  | { ok: false; code: "INVALID" | "CHANGED" | "GONE" | "RATE_LIMITED" | "UNAVAILABLE"; message: string; fieldErrors?: Record<string, string> };

const RATE_LIMIT = { submissions: 5, windowMs: 60_000 };
// On globalThis: the Server Action and the API route are separate bundles (see rows.ts).
const shared = globalThis as unknown as { formRateLimit?: Map<string, number[]> };
shared.formRateLimit ??= new Map();
const recent = shared.formRateLimit;

/** At most 5 submissions per minute per IP and form (the mock's spam protection). */
function rateLimited(key: string): boolean {
  const cutoff = Date.now() - RATE_LIMIT.windowMs;
  const times = (recent.get(key) ?? []).filter((time) => time > cutoff);
  if (times.length >= RATE_LIMIT.submissions) {
    recent.set(key, times);
    return true;
  }
  recent.set(key, [...times, Date.now()]);
  return false;
}

/**
 * A guest's answers to a public form become a record. Checked in this order: the honeypot
 * (a bot gets a fake success), the idempotency key (a repeated submit gets the first
 * result), the rate limit, the form still existing and unchanged, then the answers against
 * the form's runtime schema. The record and the key are written in one transaction.
 */
export function submitForm(viewId: string, input: unknown, ip: string): SubmitResult {
  const parsed = submissionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: "INVALID", message: "The submission is malformed" };
  const submission = parsed.data;
  const definition = formDefinition(viewId);
  const thanks = definition?.successMessage || "Thank you!";
  if (submission.website) return { ok: true, message: thanks };

  const db = getDb();
  if (db.prepare("SELECT 1 FROM form_submissions WHERE key = ? AND view_id = ?").get(submission.submissionId, viewId)) return { ok: true, message: thanks };
  if (rateLimited(`${ip}:${viewId}`)) return { ok: false, code: "RATE_LIMITED", message: "Too many submissions from your network; try again in a minute." };
  if (!definition) return { ok: false, code: "GONE", message: "This form no longer exists." };
  if (submission.version !== definition.version) {
    return { ok: false, code: "CHANGED", message: "The form was changed while you were filling it in. Please check your answers and send it again." };
  }

  const table = getTable(definition.tableId)!;
  const view = getView(viewId)!.view;
  const answers = formAnswersSchema(view.form!, table.fields, { locale: submission.locale, timeZone: submission.timeZone }).safeParse(submission.answers);
  if (!answers.success) return { ok: false, code: "INVALID", message: "Some answers need fixing.", fieldErrors: zodFieldErrors(answers.error.issues) };

  return db.transaction((): SubmitResult => {
    if (db.prepare("SELECT 1 FROM form_submissions WHERE key = ?").get(submission.submissionId)) return { ok: true, message: thanks };
    const rowId = newId("row");
    const [result] = applyRowBatch(table, [{ op: "create", rowId, values: answers.data }], { userId: "public", name: "A public form", clientId: null });
    if (!result.ok) return { ok: false, code: "INVALID", message: result.error.message, fieldErrors: result.error.fieldErrors };
    db.prepare("INSERT INTO form_submissions (key, view_id, row_id, created_at) VALUES (?, ?, ?, ?)").run(submission.submissionId, viewId, rowId, now().toISOString());
    return { ok: true, message: thanks };
  })();
}
