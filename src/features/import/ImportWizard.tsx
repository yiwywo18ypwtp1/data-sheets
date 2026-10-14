"use client";

import { useEffect, useMemo, useState } from "react";
import type { Field } from "@/lib/domain/field";
import { newId } from "@/lib/domain/ids";
import { autoMap, buildRowSchema, importTargets, linkLabels, type ColumnMapping, type ImportTarget } from "@/lib/import/mapping";
import { matchRecords } from "./api";
import { useViewerLocale } from "@/features/grid/useViewerLocale";
import { ImportStep, type ResumeState } from "./ImportStep";
import { parseCsvFile } from "./parseCsv";
import { clearSession, loadSession, saveSession, type ImportSession } from "./session";
import { MappingStep } from "./MappingStep";
import { UploadStep, type ParsedCsv } from "./UploadStep";
import { linkMatchers, ValidateStep, type ErrorStrategy, type LinkColumn, type Validation } from "./ValidateStep";

/** Rows sampled per column for type inference and the "e.g." hints. */
const SAMPLE_ROWS = 200;

const STEPS = ["File", "Columns", "Check", "Import"] as const;

export type ImportTable = { id: string; name: string; primaryFieldId: string; fields: Field[] };

type ImportWizardProps = {
  tableId: string;
  tableName: string;
  fields: Field[];
  /** The base's tables: link columns are matched against the linked table's primary field. */
  tables: ImportTable[];
  viewHref: string;
};

/** The row schema with the link columns' current matching (rebuilt when "create missing" changes). */
function schemaFor(targets: ImportTarget[], links: Map<string, LinkColumn>, options: { locale: string; timeZone: string }) {
  return buildRowSchema(targets, options, linkMatchers(links));
}

/**
 * The CSV import wizard: file → column mapping → value check → import. Each step is
 * its own component; the wizard holds what passes between them. The parsed rows and
 * the check results are plain objects (not state): they can hold 20 MB of text.
 */
export function ImportWizard({ tableId, tableName, fields, tables, viewHref }: ImportWizardProps) {
  const { locale, timeZone } = useViewerLocale();
  const [step, setStep] = useState(0);
  const [csv, setCsv] = useState<ParsedCsv | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping[] | null>(null);
  const [validation, setValidation] = useState<Validation | null>(null);
  const [strategy, setStrategy] = useState<ErrorStrategy>("skip");
  const [error, setError] = useState<string | null>(null);

  const sample = useMemo(() => {
    const rows = csv?.rows.slice(0, SAMPLE_ROWS) ?? [];
    return (column: number) => rows.map((row) => row[column] ?? "");
  }, [csv]);

  function toMapping() {
    if (!csv) return;
    // A new file starts a new mapping; going back and forth keeps the user's choices.
    if (!mapping || mapping.length !== csv.headers.length) setMapping(autoMap(csv.headers, fields, sample, { locale, timeZone }, () => newId("fld")));
    setStep(1);
  }

  const [preparing, setPreparing] = useState(false);
  const [interrupted, setInterrupted] = useState<ImportSession | null>(null);
  const [resume, setResume] = useState<ResumeState | null>(null);

  useEffect(() => {
    void loadSession(tableId).then(setInterrupted);
  }, [tableId]);

  /** The check step's input: targets, link matching and the row schema for a mapping. */
  async function prepareValidation(source: ParsedCsv, next: ColumnMapping[]): Promise<Validation> {
    const targets = importTargets(next, source.headers, fields, (column) => source.rows.map((row) => row[column] ?? ""), { locale, timeZone });
    // Link columns: find every label's record in the linked table once, before checking rows.
    const links = new Map<string, LinkColumn>();
    for (const target of targets) {
      if (target.field.type !== "link") continue;
      const linked = tables.find((table) => table.id === (target.field as Extract<Field, { type: "link" }>).targetTableId);
      if (!linked) continue;
      const labels = new Map<string, string>();
      for (const row of source.rows) for (const label of linkLabels(row[target.column] ?? "", target.field.multiple)) if (!labels.has(label.toLowerCase())) labels.set(label.toLowerCase(), label);
      const found = await matchRecords(linked.id, [...labels.values()]);
      const matches = new Map(Object.entries(found).map(([label, id]) => [label.trim().toLowerCase(), id]));
      const primary = linked.fields.find((field) => field.id === linked.primaryFieldId);
      links.set(target.field.id, {
        tableId: linked.id,
        tableName: linked.name,
        primaryFieldId: linked.primaryFieldId,
        canCreate: primary?.type === "text",
        matches,
        missing: [...labels.values()].filter((label) => !matches.has(label.toLowerCase())),
        createMissing: false,
        created: new Map(),
      });
    }
    return { targets, schema: schemaFor(targets, links, { locale, timeZone }), issues: new Map(), overrides: new Map(), links };
  }

  async function toCheck(next: ColumnMapping[]) {
    if (!csv) return;
    setMapping(next);
    setError(null);
    setPreparing(true);
    try {
      setValidation(await prepareValidation(csv, next));
      setStep(2);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Can't prepare the import");
    } finally {
      setPreparing(false);
    }
  }

  /** Picks an interrupted import up where it stopped: same file, same choices, same import id. */
  function resumeSession(session: ImportSession) {
    setPreparing(true);
    setError(null);
    parseCsvFile(session.file, { encoding: session.encoding, delimiter: session.delimiter }, () => undefined, (result) => {
      if (!result.ok) {
        setPreparing(false);
        return setError(result.error);
      }
      prepareValidation(result.csv, session.mapping).then(
        (prepared) => {
          for (const [row, columns] of session.overrides) prepared.overrides.set(row, new Map(columns));
          for (const [fieldId, saved] of session.links) {
            const link = prepared.links.get(fieldId);
            // Records this import created are found by name now; the saved ids cover the ones it still has to.
            if (link) prepared.links.set(fieldId, { ...link, createMissing: saved.createMissing, created: new Map(saved.created) });
          }
          prepared.schema = schemaFor(prepared.targets, prepared.links, { locale, timeZone });
          setCsv(result.csv);
          setMapping(session.mapping);
          setStrategy(session.strategy);
          setValidation(prepared);
          setResume({ importId: session.importId, progress: session.progress, report: session.report, fieldsCreated: session.fieldsCreated });
          setInterrupted(null);
          setPreparing(false);
          setStep(3);
        },
        (cause) => {
          setPreparing(false);
          setError(cause instanceof Error ? cause.message : "Can't resume the import");
        },
      );
    });
  }

  function checkpoint(state: ResumeState | null) {
    if (!state || !csv || !mapping || !validation) return void clearSession(tableId);
    void saveSession({
      tableId,
      file: csv.file,
      encoding: csv.encoding,
      delimiter: csv.delimiter,
      mapping,
      strategy,
      overrides: [...validation.overrides.entries()].map(([row, columns]) => [row, [...columns.entries()]]),
      links: [...validation.links.entries()].map(([fieldId, link]) => [fieldId, { createMissing: link.createMissing, created: [...link.created.entries()] }]),
      ...state,
      savedAt: new Date().toISOString(),
    });
  }

  function setCreateMissing(fieldId: string, create: boolean) {
    if (!validation) return;
    const links = new Map(validation.links);
    links.set(fieldId, { ...links.get(fieldId)!, createMissing: create });
    // A new object: the check step runs again with the new schema; fixes typed so far are kept.
    setValidation({ ...validation, links, schema: schemaFor(validation.targets, links, { locale, timeZone }), issues: new Map() });
  }

  const newFieldIds = new Set(mapping?.flatMap((column) => (column.action === "new" ? [column.newFieldId] : [])));
  const newFields = validation?.targets.map((target) => target.field).filter((field) => newFieldIds.has(field.id)) ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 p-4">
      <div className="flex items-baseline gap-4">
        <h1 className="text-lg font-semibold">Import CSV into {tableName}</h1>
        <ol aria-label="Steps" className="flex gap-3 text-sm">
          {STEPS.map((label, index) => (
            <li key={label} aria-current={index === step ? "step" : undefined} className={index === step ? "font-semibold text-blue-700 dark:text-blue-300" : "text-zinc-400"}>
              {index + 1}. {label}
            </li>
          ))}
        </ol>
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      {interrupted && step === 0 && (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm dark:border-amber-700 dark:bg-amber-950">
          <span>
            An import of <strong>{interrupted.file.name}</strong> stopped at {interrupted.progress.nextRow.toLocaleString()} rows ({new Date(interrupted.savedAt).toLocaleString(locale)}).
          </span>
          <button type="button" className="rounded bg-blue-600 px-3 py-1 text-white hover:bg-blue-700 disabled:opacity-40" disabled={preparing} onClick={() => resumeSession(interrupted)}>
            Resume
          </button>
          <button
            type="button"
            className="rounded px-3 py-1 hover:bg-amber-100 dark:hover:bg-amber-900"
            onClick={() => {
              void clearSession(tableId);
              setInterrupted(null);
            }}
          >
            Discard
          </button>
        </div>
      )}
      {step === 0 && (
        <UploadStep
          parsed={csv}
          onParsed={(parsed) => {
            setCsv(parsed);
            setMapping(null);
          }}
          onNext={toMapping}
        />
      )}
      {step === 1 && csv && mapping && (
        <MappingStep csv={csv} fields={fields} sample={sample} initial={mapping} locale={locale} timeZone={timeZone} onBack={() => setStep(0)} onNext={(next) => void toCheck(next)} />
      )}
      {preparing && (
        <p role="status" className="text-sm text-zinc-500">
          Preparing the import…
        </p>
      )}
      {step === 2 && csv && validation && (
        <ValidateStep csv={csv} validation={validation} onCreateMissing={setCreateMissing} strategy={strategy} onStrategy={setStrategy} onBack={() => setStep(1)} onNext={() => setStep(3)} />
      )}
      {step === 3 && csv && validation && (
        <ImportStep
          tableId={tableId}
          csv={csv}
          validation={validation}
          strategy={strategy}
          newFields={newFields}
          locale={locale}
          timeZone={timeZone}
          viewHref={viewHref}
          onBack={() => setStep(2)}
          resume={resume}
          onCheckpoint={checkpoint}
        />
      )}
    </div>
  );
}
