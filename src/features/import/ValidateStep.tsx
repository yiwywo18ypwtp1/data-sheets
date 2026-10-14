import { useEffect, useState } from "react";
import { buildRowSchema, rowInput, type ImportTarget } from "@/lib/import/mapping";
import { buttonClass, inputClass, primaryButtonClass } from "./styles";
import type { ParsedCsv } from "./UploadStep";

/** What to do with a row that still has invalid values when importing. */
export type ErrorStrategy = "skip" | "empty";

/**
 * The checked import: the runtime row schema, the problems it found (row → column →
 * message) and the values the user fixed in the error table (row → column → text).
 * Mutable maps in a plain object, owned by the wizard: 20 MB of CSV can have tens of
 * thousands of problems, too many to copy into React state on every keystroke.
 */
export type Validation = {
  targets: ImportTarget[];
  schema: ReturnType<typeof buildRowSchema>;
  issues: Map<number, Map<number, string>>;
  overrides: Map<number, Map<number, string>>;
};

const ROWS_PER_CHUNK = 2000;
const PAGE_SIZE = 50;
const yieldToBrowser = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Checks one CSV row against the row schema and records its problems by column. */
export function validateRow(validation: Validation, csv: ParsedCsv, rowIndex: number): void {
  const overrides = validation.overrides.get(rowIndex);
  const result = validation.schema.safeParse(rowInput(validation.targets, csv.rows[rowIndex], (column) => overrides?.get(column)));
  if (result.success) {
    validation.issues.delete(rowIndex);
    return;
  }
  const columnOf = new Map(validation.targets.map((target) => [target.field.id, target.column]));
  const problems = new Map<number, string>();
  for (const issue of result.error.issues) problems.set(columnOf.get(String(issue.path[0]))!, issue.message);
  validation.issues.set(rowIndex, problems);
}

type ValidateStepProps = {
  csv: ParsedCsv;
  validation: Validation;
  strategy: ErrorStrategy;
  onStrategy: (strategy: ErrorStrategy) => void;
  onBack: () => void;
  onNext: () => void;
};

/**
 * Step 3: every row is run through the zod schema built from the mapping, in chunks
 * so the page stays responsive. Rows with problems are listed with the bad values
 * editable in place (a fix is re-checked at once); whatever is left is skipped or
 * imported as empty, as the user chooses.
 */
export function ValidateStep({ csv, validation, strategy, onStrategy, onBack, onNext }: ValidateStepProps) {
  const [checked, setChecked] = useState(0);
  const [listed, setListed] = useState<number[] | null>(null);
  const [page, setPage] = useState(0);
  const [, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      validation.issues.clear();
      for (let start = 0; start < csv.rows.length; start += ROWS_PER_CHUNK) {
        const end = Math.min(csv.rows.length, start + ROWS_PER_CHUNK);
        for (let row = start; row < end; row++) validateRow(validation, csv, row);
        setChecked(end);
        await yieldToBrowser();
        if (cancelled) return;
      }
      // The list is fixed once checked: a row the user fixes stays in it (marked fixed) instead of jumping away.
      setListed([...validation.issues.keys()].sort((a, b) => a - b));
    })();
    return () => {
      cancelled = true;
    };
  }, [csv, validation]);

  function fix(rowIndex: number, column: number, text: string) {
    const overrides = validation.overrides.get(rowIndex) ?? new Map<number, string>();
    overrides.set(column, text);
    validation.overrides.set(rowIndex, overrides);
    validateRow(validation, csv, rowIndex);
    setVersion((version) => version + 1);
  }

  if (!listed) {
    return (
      <section className="flex flex-col gap-3">
        <h2 className="font-semibold">3. Check values</h2>
        <div className="flex items-center gap-3 text-sm">
          <progress aria-label="Checking rows" value={checked} max={csv.rows.length} className="w-64" />
          {checked.toLocaleString()} of {csv.rows.length.toLocaleString()} rows checked…
        </div>
      </section>
    );
  }

  const badRows = validation.issues.size;
  const badCells = [...validation.issues.values()].reduce((sum, problems) => sum + problems.size, 0);
  const pages = Math.max(1, Math.ceil(listed.length / PAGE_SIZE));
  const shown = listed.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const importing = strategy === "skip" ? csv.rows.length - badRows : csv.rows.length;

  return (
    <section aria-labelledby="validate-title" className="flex min-h-0 flex-col gap-3">
      <h2 id="validate-title" className="font-semibold">
        3. Check values
      </h2>
      <p role="status" className="text-sm">
        {badRows === 0 ? (
          <>All {csv.rows.length.toLocaleString()} rows are valid.</>
        ) : (
          <>
            {(csv.rows.length - badRows).toLocaleString()} rows are valid; <strong>{badRows.toLocaleString()}</strong> rows have {badCells.toLocaleString()} values that can&apos;t be
            converted. Fix them below, or choose what happens to them.
          </>
        )}
      </p>

      {listed.length > 0 && (
        <>
          <fieldset className="flex flex-wrap gap-4 text-sm">
            <legend className="sr-only">Rows with errors</legend>
            <label className="flex items-center gap-1.5">
              <input type="radio" name="strategy" checked={strategy === "skip"} onChange={() => onStrategy("skip")} />
              Skip rows with errors
            </label>
            <label className="flex items-center gap-1.5">
              <input type="radio" name="strategy" checked={strategy === "empty"} onChange={() => onStrategy("empty")} />
              Import them, leaving the invalid values empty
            </label>
          </fieldset>
          <div className="min-h-0 overflow-auto rounded border border-zinc-200 dark:border-zinc-800">
            <table className="w-full text-sm">
              <caption className="sr-only">Rows with values that can&apos;t be imported</caption>
              <thead className="sticky top-0 bg-zinc-50 text-left text-zinc-500 dark:bg-zinc-900">
                <tr>
                  <th scope="col" className="px-2 py-1 font-normal">
                    Row
                  </th>
                  <th scope="col" className="px-2 py-1 font-normal">
                    Column
                  </th>
                  <th scope="col" className="px-2 py-1 font-normal">
                    Value
                  </th>
                  <th scope="col" className="px-2 py-1 font-normal">
                    Problem
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.flatMap((rowIndex) => {
                  const problems = validation.issues.get(rowIndex);
                  // Columns that had a problem when listed, so a fixed cell stays visible as fixed.
                  const columns = validation.targets.filter((target) => problems?.has(target.column) || validation.overrides.get(rowIndex)?.has(target.column));
                  if (columns.length === 0) {
                    return [
                      <tr key={rowIndex} className="border-t border-zinc-100 dark:border-zinc-800">
                        <td className="px-2 py-1 text-zinc-500">{rowIndex + 2}</td>
                        <td colSpan={3} className="px-2 py-1 text-green-700 dark:text-green-400">
                          Fixed
                        </td>
                      </tr>,
                    ];
                  }
                  return columns.map((target) => {
                    const message = problems?.get(target.column);
                    const value = validation.overrides.get(rowIndex)?.get(target.column) ?? csv.rows[rowIndex][target.column] ?? "";
                    return (
                      <tr key={`${rowIndex}:${target.column}`} className="border-t border-zinc-100 dark:border-zinc-800">
                        {/* +2: the header is line 1 of the file, so data row 0 is line 2, as a spreadsheet shows it. */}
                        <td className="px-2 py-1 text-zinc-500">{rowIndex + 2}</td>
                        <td className="px-2 py-1">{target.header}</td>
                        <td className="px-2 py-1">
                          <input
                            aria-label={`Value of ${target.header} in row ${rowIndex + 2}`}
                            aria-invalid={message ? true : undefined}
                            className={`${inputClass} w-full min-w-40`}
                            value={value}
                            onChange={(event) => fix(rowIndex, target.column, event.target.value)}
                          />
                        </td>
                        <td className={`px-2 py-1 ${message ? "text-red-600" : "text-green-700 dark:text-green-400"}`}>{message ?? "Fixed"}</td>
                      </tr>
                    );
                  });
                })}
              </tbody>
            </table>
          </div>
          {pages > 1 && (
            <nav aria-label="Error pages" className="flex items-center gap-2 text-sm">
              <button type="button" className={buttonClass} disabled={page === 0} onClick={() => setPage(page - 1)}>
                Previous
              </button>
              Page {page + 1} of {pages}
              <button type="button" className={buttonClass} disabled={page === pages - 1} onClick={() => setPage(page + 1)}>
                Next
              </button>
            </nav>
          )}
        </>
      )}

      <div className="flex gap-2">
        <button type="button" className={buttonClass} onClick={onBack}>
          Back
        </button>
        <button type="button" className={`${primaryButtonClass} ml-auto`} disabled={importing === 0} onClick={onNext}>
          Import {importing.toLocaleString()} rows
        </button>
      </div>
    </section>
  );
}
