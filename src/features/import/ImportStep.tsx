import Link from "next/link";
import Papa from "papaparse";
import { useEffect, useRef, useState } from "react";
import { createCoercer } from "@/lib/coerce/coerce";
import type { CellValue } from "@/lib/domain/cell";
import type { Field } from "@/lib/domain/field";
import { newId } from "@/lib/domain/ids";
import { rowInput } from "@/lib/import/mapping";
import { createField } from "@/features/fields/api";
import { ApiRequestError } from "@/features/grid/api";
import { importRowsAction } from "./actions";
import { buttonClass, primaryButtonClass } from "./styles";
import type { ParsedCsv } from "./UploadStep";
import type { ErrorStrategy, Validation } from "./ValidateStep";

const BATCH_ROWS = 500;
/** Server Actions accept 4 MB here (next.config.ts); a batch of wide rows is cut earlier. */
const BATCH_BYTES = 3 * 1024 * 1024;
const ATTEMPTS = 3;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type ReportLine = { row: number; outcome: "skipped" | "imported with empty values" | "rejected by the server"; column: string; value: string; problem: string };

type Progress = { nextRow: number; batchIndex: number; imported: number; skipped: number; emptied: number; rejected: number };

type Phase = { kind: "ready" } | { kind: "running" } | { kind: "cancelled" } | { kind: "failed"; message: string } | { kind: "done" };

type ImportStepProps = {
  tableId: string;
  csv: ParsedCsv;
  validation: Validation;
  strategy: ErrorStrategy;
  /** Fields the mapping creates; made before the first batch. */
  newFields: Field[];
  locale: string;
  timeZone: string;
  viewHref: string;
  onBack: () => void;
};

/**
 * Step 4: creates the new fields, then sends the rows in batches through a Server Action.
 * Each batch carries an idempotency key (this import's id + the batch number), so a batch
 * whose answer was lost is retried without importing it twice, and "Continue" after a
 * cancel or a failure picks up at the next batch. Progress lives in a ref: it's advanced
 * by an async loop, not by renders.
 */
export function ImportStep({ tableId, csv, validation, strategy, newFields, locale, timeZone, viewHref, onBack }: ImportStepProps) {
  const [importId] = useState(() => newId("imp"));
  const [phase, setPhase] = useState<Phase>({ kind: "ready" });
  const progress = useRef<Progress>({ nextRow: 0, batchIndex: 0, imported: 0, skipped: 0, emptied: 0, rejected: 0 });
  const report = useRef<ReportLine[]>([]);
  const fieldsCreated = useRef(false);
  const cancelRequested = useRef(false);
  const [, setTick] = useState(0);
  const [reportUrl, setReportUrl] = useState<string | null>(null);

  useEffect(() => () => {
    if (reportUrl) URL.revokeObjectURL(reportUrl);
  }, [reportUrl]);

  /** The values to create for one CSV row, or null if it's skipped. Problems go into the report. */
  function rowValues(rowIndex: number, coercers: ((text: string) => ReturnType<ReturnType<typeof createCoercer>>)[]): Record<string, CellValue> | null {
    const overrides = validation.overrides.get(rowIndex);
    const input = rowInput(validation.targets, csv.rows[rowIndex], (column) => overrides?.get(column));
    const parsed = validation.schema.safeParse(input);
    const values: Record<string, CellValue> = {};
    if (parsed.success) {
      for (const [fieldId, value] of Object.entries(parsed.data)) if (value !== null) values[fieldId] = value;
      return values;
    }
    const lines = (outcome: ReportLine["outcome"]) =>
      validation.targets.flatMap((target, i) => {
        const result = coercers[i](input[target.field.id]);
        return result.ok ? [] : [{ row: rowIndex + 2, outcome, column: target.header, value: input[target.field.id], problem: result.error }];
      });
    if (strategy === "skip") {
      report.current.push(...lines("skipped"));
      progress.current.skipped++;
      return null;
    }
    report.current.push(...lines("imported with empty values"));
    progress.current.emptied++;
    validation.targets.forEach((target, i) => {
      const result = coercers[i](input[target.field.id]);
      if (result.ok && result.value !== null) values[target.field.id] = result.value;
    });
    return values;
  }

  async function sendBatch(rows: Record<string, CellValue>[], rowNumbers: number[]) {
    const batchIndex = progress.current.batchIndex;
    for (let attempt = 1; ; attempt++) {
      try {
        const outcome = await importRowsAction({ tableId, importId, batchIndex, rows });
        if (!outcome.ok) throw new Error(outcome.message);
        progress.current.imported += outcome.result.imported;
        progress.current.rejected += outcome.result.failed.length;
        for (const failure of outcome.result.failed) {
          report.current.push({ row: rowNumbers[failure.index], outcome: "rejected by the server", column: "", value: "", problem: failure.message });
        }
        progress.current.batchIndex++;
        return;
      } catch (error) {
        // The same key is sent again: if the first attempt did reach the server, nothing is imported twice.
        if (attempt >= ATTEMPTS) throw error;
        await sleep(500 * 2 ** attempt);
      }
    }
  }

  async function run() {
    cancelRequested.current = false;
    setPhase({ kind: "running" });
    try {
      if (!fieldsCreated.current) {
        for (const field of newFields) {
          try {
            await createField(tableId, field);
          } catch (error) {
            // 409: created by an earlier attempt of this import (the id is fixed by the mapping).
            if (!(error instanceof ApiRequestError && error.status === 409)) throw error;
          }
        }
        fieldsCreated.current = true;
      }

      const coercers = validation.targets.map((target) => createCoercer(target.field, { locale, timeZone }));
      while (progress.current.nextRow < csv.rows.length) {
        if (cancelRequested.current) return setPhase({ kind: "cancelled" });
        const start = progress.current.nextRow;
        const rows: Record<string, CellValue>[] = [];
        const rowNumbers: number[] = [];
        let bytes = 0;
        let row = start;
        const reportLength = report.current.length;
        const counts = { skipped: progress.current.skipped, emptied: progress.current.emptied };
        for (; row < csv.rows.length && rows.length < BATCH_ROWS && bytes < BATCH_BYTES; row++) {
          const values = rowValues(row, coercers);
          if (!values) continue;
          rows.push(values);
          rowNumbers.push(row + 2);
          bytes += JSON.stringify(values).length;
        }
        try {
          if (rows.length > 0) await sendBatch(rows, rowNumbers);
        } catch (error) {
          // Not sent: this stretch of rows is prepared again (and counted once) when continuing.
          report.current.length = reportLength;
          Object.assign(progress.current, counts);
          throw error;
        }
        progress.current.nextRow = row;
        setTick((tick) => tick + 1);
      }
      setPhase({ kind: "done" });
      const csvReport = Papa.unparse(report.current, { columns: ["row", "outcome", "column", "value", "problem"] });
      setReportUrl(URL.createObjectURL(new Blob([csvReport], { type: "text/csv;charset=utf-8" })));
    } catch (error) {
      setPhase({ kind: "failed", message: error instanceof Error ? error.message : "The import failed" });
    }
  }

  const { nextRow, imported, skipped, emptied, rejected } = progress.current;
  const total = csv.rows.length;

  return (
    <section aria-labelledby="import-title" className="flex flex-col gap-3 text-sm">
      <h2 id="import-title" className="text-base font-semibold">
        4. Import
      </h2>
      {phase.kind === "ready" && (
        <>
          <p>
            {total.toLocaleString()} rows from <strong>{csv.fileName}</strong>
            {newFields.length > 0 && <> into {newFields.length} new and {validation.targets.length - newFields.length} existing fields</>}.{" "}
            {strategy === "skip" ? "Rows with errors will be skipped." : "Invalid values will be left empty."}
          </p>
          <div className="flex gap-2">
            <button type="button" className={buttonClass} onClick={onBack}>
              Back
            </button>
            <button type="button" className={`${primaryButtonClass} ml-auto`} onClick={() => void run()}>
              Start import
            </button>
          </div>
        </>
      )}

      {phase.kind !== "ready" && (
        <div className="flex items-center gap-3">
          <progress aria-label="Import progress" value={nextRow} max={total} className="w-80" />
          <span role="status">
            {nextRow.toLocaleString()} of {total.toLocaleString()} rows processed
          </span>
          {phase.kind === "running" && (
            <button type="button" className={buttonClass} onClick={() => (cancelRequested.current = true)}>
              Cancel
            </button>
          )}
        </div>
      )}

      {(phase.kind === "cancelled" || phase.kind === "failed") && (
        <div role="alert" className="flex items-center gap-3">
          <span className={phase.kind === "failed" ? "text-red-600" : ""}>
            {phase.kind === "failed" ? `Stopped: ${phase.message}` : "Cancelled."} Rows imported so far stay in the table.
          </span>
          <button type="button" className={primaryButtonClass} onClick={() => void run()}>
            Continue
          </button>
        </div>
      )}

      {phase.kind !== "ready" && (
        <dl className="grid w-max grid-cols-2 gap-x-6 gap-y-1">
          <dt>Imported</dt>
          <dd className="font-semibold">{imported.toLocaleString()}</dd>
          <dt>Skipped (errors)</dt>
          <dd>{skipped.toLocaleString()}</dd>
          <dt>Imported with empty values</dt>
          <dd>{emptied.toLocaleString()}</dd>
          <dt>Rejected by the server</dt>
          <dd>{rejected.toLocaleString()}</dd>
        </dl>
      )}

      {phase.kind === "done" && (
        <div className="flex items-center gap-4">
          <span role="status" className="font-medium text-green-700 dark:text-green-400">
            Import finished.
          </span>
          {reportUrl && report.current.length > 0 && (
            <a href={reportUrl} download={`${csv.fileName.replace(/\.[^.]+$/, "")}-import-report.csv`} className="text-blue-600 hover:underline">
              Download the report ({report.current.length.toLocaleString()} problems)
            </a>
          )}
          <Link href={viewHref} className={primaryButtonClass}>
            Open the table
          </Link>
        </div>
      )}
    </section>
  );
}
