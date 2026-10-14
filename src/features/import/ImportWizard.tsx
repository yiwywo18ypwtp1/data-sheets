"use client";

import { useMemo, useState } from "react";
import type { Field } from "@/lib/domain/field";
import { newId } from "@/lib/domain/ids";
import { autoMap, buildRowSchema, importTargets, type ColumnMapping } from "@/lib/import/mapping";
import { useViewerLocale } from "@/features/grid/useViewerLocale";
import { ImportStep } from "./ImportStep";
import { MappingStep } from "./MappingStep";
import { UploadStep, type ParsedCsv } from "./UploadStep";
import { ValidateStep, type ErrorStrategy, type Validation } from "./ValidateStep";

/** Rows sampled per column for type inference and the "e.g." hints. */
const SAMPLE_ROWS = 200;

const STEPS = ["File", "Columns", "Check", "Import"] as const;

type ImportWizardProps = { tableId: string; tableName: string; fields: Field[]; viewHref: string };

/**
 * The CSV import wizard: file → column mapping → value check → import. Each step is
 * its own component; the wizard holds what passes between them. The parsed rows and
 * the check results are plain objects (not state): they can hold 20 MB of text.
 */
export function ImportWizard({ tableId, tableName, fields, viewHref }: ImportWizardProps) {
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

  function toCheck(next: ColumnMapping[]) {
    if (!csv) return;
    setMapping(next);
    setError(null);
    try {
      const targets = importTargets(next, csv.headers, fields, (column) => csv.rows.map((row) => row[column] ?? ""), { locale, timeZone });
      setValidation({ targets, schema: buildRowSchema(targets, { locale, timeZone }), issues: new Map(), overrides: new Map() });
      setStep(2);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Can't prepare the import");
    }
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
        <MappingStep csv={csv} fields={fields} sample={sample} initial={mapping} locale={locale} timeZone={timeZone} onBack={() => setStep(0)} onNext={toCheck} />
      )}
      {step === 2 && csv && validation && (
        <ValidateStep csv={csv} validation={validation} strategy={strategy} onStrategy={setStrategy} onBack={() => setStep(1)} onNext={() => setStep(3)} />
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
        />
      )}
    </div>
  );
}
