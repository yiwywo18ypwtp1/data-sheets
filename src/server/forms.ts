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

/**
 * At most 5 submissions per minute per client and form, and 60 per minute per form whatever
 * the clients claim to be: the second limit is what a spoofed address can't get around.
 */
const RATE_LIMIT = { perClient: 5, perForm: 60, windowMs: 60_000, maxKeys: 10_000 };
// On globalThis: the Server Action and the API route are separate bundles (see rows.ts).
const shared = globalThis as unknown as { formRateLimit?: { hits: Map<string, number[]>; sweptAt: number } };
shared.formRateLimit ??= { hits: new Map(), sweptAt: 0 };
const limiter = shared.formRateLimit;

/**
 * Who is submitting, as far as the server can tell. Node doesn't give a Route Handler or a
 * Server Action the socket's address, and `X-Forwarded-For` is whatever the client wrote
 * (Next.js only fills it in when it's missing), so it is not believed by default: everyone
 * is "direct" and shares the per-form limits. Behind a reverse proxy that appends the
 * peer's address, `TRUSTED_PROXY_HOPS=1` takes the entry that proxy added: the last one,
 * counted from the right, which the client can't write (the ones before it are theirs).
 */
export function clientKeyOf(headers: Headers): string {
  const hops = Math.trunc(Number(process.env.TRUSTED_PROXY_HOPS ?? 0));
  if (!(hops > 0)) return "direct";
  const entries = (headers.get("x-forwarded-for") ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  return entries.at(-hops)?.slice(0, 64) ?? "direct";
}

/** Drops keys whose hits have all left the window, and the oldest keys beyond `maxKeys`. Runs at most once a window. */
function sweep(time: number): void {
  if (time - limiter.sweptAt < RATE_LIMIT.windowMs) return;
  limiter.sweptAt = time;
  const cutoff = time - RATE_LIMIT.windowMs;
  for (const [key, times] of limiter.hits) if (times[times.length - 1] <= cutoff) limiter.hits.delete(key);
}

function recentHits(key: string, cutoff: number): number[] {
  return (limiter.hits.get(key) ?? []).filter((time) => time > cutoff);
}

/** Counts one submission, unless it is over a limit. Re-inserting a key keeps the map in order of recency. */
function rateLimited(clientKey: string, viewId: string): boolean {
  const time = Date.now();
  sweep(time);
  const cutoff = time - RATE_LIMIT.windowMs;
  const clientHits = `client:${clientKey}:${viewId}`;
  const formHits = `form:${viewId}`;
  const client = recentHits(clientHits, cutoff);
  const form = recentHits(formHits, cutoff);
  if (client.length >= RATE_LIMIT.perClient || form.length >= RATE_LIMIT.perForm) return true;
  for (const [key, times] of [[clientHits, client], [formHits, form]] as const) {
    limiter.hits.delete(key);
    limiter.hits.set(key, [...times, time]);
  }
  while (limiter.hits.size > RATE_LIMIT.maxKeys) limiter.hits.delete(limiter.hits.keys().next().value!);
  return false;
}

/**
 * A guest's answers to a public form become a record. Checked in this order: the honeypot
 * (a bot gets a fake success), the idempotency key (a repeated submit gets the first
 * result), the form still existing (so made-up ids don't fill the rate limiter), the rate
 * limit, the form being unchanged, then the answers against
 * the form's runtime schema. The record and the key are written in one transaction.
 */
export function submitForm(viewId: string, input: unknown, clientKey: string): SubmitResult {
  const parsed = submissionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: "INVALID", message: "The submission is malformed" };
  const submission = parsed.data;
  const definition = formDefinition(viewId);
  const thanks = definition?.successMessage || "Thank you!";
  if (submission.website) return { ok: true, message: thanks };

  const db = getDb();
  if (db.prepare("SELECT 1 FROM form_submissions WHERE key = ? AND view_id = ?").get(submission.submissionId, viewId)) return { ok: true, message: thanks };
  if (!definition) return { ok: false, code: "GONE", message: "This form no longer exists." };
  if (rateLimited(clientKey, viewId)) return { ok: false, code: "RATE_LIMITED", message: "Too many submissions; try again in a minute." };
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
