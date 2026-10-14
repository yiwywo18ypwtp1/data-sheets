"use server";

import { headers } from "next/headers";
import { simulateNetwork } from "@/server/api";
import { submitForm, type Submission, type SubmitResult } from "@/server/forms";

/**
 * The public form's submit. Runs `submitForm` (idempotency, honeypot, rate limit by IP,
 * form version, runtime schema). MOCK_LATENCY_MS applies here too, to try double submits.
 */
export async function submitFormAction(viewId: string, submission: Submission): Promise<SubmitResult> {
  try {
    await simulateNetwork();
  } catch {
    // MOCK_FAILURE_RATE: the guest sends again; the same submissionId keeps it to one record.
    return { ok: false, code: "UNAVAILABLE", message: "Couldn't send your answers. Please try again." };
  }
  const forwarded = (await headers()).get("x-forwarded-for");
  return submitForm(viewId, submission, forwarded?.split(",")[0]?.trim() || "local");
}
