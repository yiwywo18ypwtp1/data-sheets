import Link from "next/link";
import Papa from "papaparse";
import { useEffect, useRef, useState } from "react";
import type { CellValue } from "@/lib/domain/cell";
import type { Field } from "@/lib/domain/field";
import { newId } from "@/lib/domain/ids";
import { coercerFor, NEW_RECORD_PREFIX, rowInput } from "@/lib/import/mapping";
import { createField } from "@/features/fields/api";
import { ApiRequestError, sendRowBatch } from "@/features/grid/api";
import { importRowsAction } from "./actions";
import { buttonClass, primaryButtonClass } from "./styles";
import type { ImportProgress, ReportLine } from "./session";
import type { ParsedCsv } from "./UploadStep";
import { linkMatchers, type ErrorStrategy, type Validation } from "./ValidateStep";

const BATCH_ROWS = 500;
/** Server Actions accept 4 MB here (next.config.ts); a batch of wide rows is cut earlier. */
const BATCH_BYTES = 3 * 1024 * 1024;
const ATTEMPTS = 3;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));


type Progress = ImportProgress;

/** Where an interrupted import stopped (from the saved session). */
export type ResumeState = { importId: string; progress: ImportProgress; report: ReportLine[]; fieldsCreated: boolean };

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
  /** Continue an interrupted import instead of starting one. */
  resume: ResumeState | null;
  /** Saves the import's state after each batch (for resuming after a reload); `null` when it finished. */
  onCheckpoint: (state: ResumeState | null) => void;
};

/**
 * Step 4: creates the new fields, then sends the rows in batches through a Server Action.
 * Each batch carries an idempotency key (this import's id + the batch number), so a batch
 * whose answer was lost is retried without importing it twice, and "Continue" after a
 * cancel or a failure picks up at the next batch. Progress lives in a ref: it's advanced
 * by an async loop, not by renders.
 */
export function ImportStep({ tableId, csv, validation, strategy, newFields, locale, timeZone, viewHref, onBack, resume, onCheckpoint }: ImportStepProps) {
  const [importId] = useState(() => resume?.importId ?? newId("imp"));
  // A resumed import shows where it stopped and a "Continue" button.
  const [phase, setPhase] = useState<Phase>(resume ? { kind: "cancelled" } : { kind: "ready" });
  const progress = useRef<Progress>(resume ? { ...resume.progress } : { nextRow: 0, batchIndex: 0, imported: 0, skipped: 0, emptied: 0, rejected: 0, createdRecords: 0 });
  const report = useRef<ReportLine[]>(resume ? [...resume.report] : []);
  const fieldsCreated = useRef(resume?.fieldsCreated ?? false);
  const checkpoint = () => onCheckpoint({ importId, progress: { ...progress.current }, report: report.current, fieldsCreated: fieldsCreated.current });
  const cancelRequested = useRef(false);
  const [, setTick] = useState(0);
  const [reportUrl, setReportUrl] = useState<string | null>(null);

  useEffect(() => () => {
    if (reportUrl) URL.revokeObjectURL(reportUrl);
  }, [reportUrl]);

  /** The values to create for one CSV row, or null if it's skipped. Problems go into the report. */
  function rowValues(rowIndex: number, coercers: ReturnType<typeof coercerFor>[]): Record<string, CellValue> | null {
    const overrides = validation.overrides.get(rowIndex);
    const input = rowInput(validation.targets, csv.rows[rowIndex], (column) => overrides?.get(column));
    const parsed = validation.schema.safeParse(input);
    const values: Record<string, CellValue> = {};
    if (parsed.success) {
      for (const [fieldId, value] of Object.entries(parsed.data)) if (value !== null) values[fieldId] = withCreatedRecords(fieldId, value);
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
      if (result.ok && result.value !== null) values[target.field.id] = withCreatedRecords(target.field.id, result.value);
    });
    return values;
  }

  /** Link values name records to create as `new:<label>`; by now they exist, so the placeholder becomes their id. */
  function withCreatedRecords(fieldId: string, value: CellValue): CellValue {
    const link = validation.links.get(fieldId);
    if (!link || !Array.isArray(value)) return value;
    return value.map((id) => (id.startsWith(NEW_RECORD_PREFIX) ? link.created.get(id.slice(NEW_RECORD_PREFIX.length).toLowerCase())! : id));
  }

  /**
   * Creates the linked records that link columns name but that don't exist (when the user
   * asked for it), in the linked tables, before any row. Their ids are chosen here and kept,
   * so a retry sends the same ids and the server's "already exists" just means done.
   */
  async function createMissingRecords() {
    for (const link of validation.links.values()) {
      if (!link.createMissing) continue;
      for (const label of link.missing) if (!link.created.has(label.toLowerCase())) link.created.set(label.toLowerCase(), newId("row"));
      const ops = link.missing.map((label) => ({ op: "create" as const, rowId: link.created.get(label.toLowerCase())!, values: { [link.primaryFieldId]: label } }));
      for (let start = 0; start < ops.length; start += 1000) {
        const results = await sendRowBatch(link.tableId, ops.slice(start, start + 1000));
        const failed = results.find((result) => !result.ok && result.error.code !== "CONFLICT");
        if (failed && !failed.ok) throw new Error(`Couldn't create a record in ${link.tableName}: ${failed.error.message}`);
      }
    }
    progress.current.createdRecords = [...validation.links.values()].reduce((sum, link) => sum + (link.createMissing ? link.missing.length : 0), 0);
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
        await createMissingRecords();
        fieldsCreated.current = true;
        checkpoint(); // the ids of created records are saved before any row refers to them
      }

      const matchers = linkMatchers(validation.links);
      const coercers = validation.targets.map((target) => coercerFor(target, { locale, timeZone }, matchers));
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
        checkpoint();
        setTick((tick) => tick + 1);
      }
      setPhase({ kind: "done" });
      onCheckpoint(null);
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
            {phase.kind === "failed" ? `Stopped: ${phase.message}` : resume && progress.current.nextRow === resume.progress.nextRow ? "This import was interrupted." : "Cancelled."} Rows imported so far stay in the table.
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
          {progress.current.createdRecords > 0 && (
            <>
              <dt>Linked records created</dt>
              <dd>{progress.current.createdRecords.toLocaleString()}</dd>
            </>
          )}
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
