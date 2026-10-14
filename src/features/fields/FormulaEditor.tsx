import { useEffect, useMemo, useState } from "react";
import { useFormContext, useWatch } from "react-hook-form";
import type { Field, FormulaResultType } from "@/lib/domain/field";
import type { Row } from "@/lib/domain/row";
import { createCellFormatter } from "@/lib/format";
import { FUNCTIONS } from "@/lib/formula/functions";
import { checkFormula, type FormulaCheck } from "./api";
import { ErrorText, inputClass, labelClass } from "./Dialog";
import { FormulaSyntaxError, previewFormula } from "./fieldForm";

const CHECK_DELAY_MS = 300;

type FormulaEditorProps = {
  tableId: string;
  /** Set when editing: the server then also checks for cycles through this field. */
  fieldId?: string;
  /** The table's fields with the edited one as it is now, for names and the preview. */
  fields: Field[];
  /** The first loaded rows of the grid. */
  previewRows: Row[];
  locale: string;
  timeZone: string;
};

type Problem = { message: string; position: number };

/**
 * Formula input with immediate feedback:
 * - syntax and type errors with their position come from the formula engine on the client
 *   (the same code the server runs), so they show while typing;
 * - cycles can go through other tables (lookups), so the server checks them (debounced);
 * - the result on the first 5 rows of the grid is computed on the client.
 * The inferred result type is written into the form, so the field is saved with it.
 */
export function FormulaEditor({ tableId, fieldId, fields, previewRows, locale, timeZone }: FormulaEditorProps) {
  const { register, setValue, control, formState } = useFormContext<Field>();
  const expression = (useWatch({ control, name: "expression" }) as string | undefined) ?? "";
  const [serverCheck, setServerCheck] = useState<{ expression: string; result: FormulaCheck } | null>(null);

  const local = useMemo(() => {
    if (expression.trim() === "") return null;
    try {
      return { rows: previewFormula(expression, fields, previewRows, { now: new Date(), timeZone }), problem: null };
    } catch (error) {
      if (error instanceof FormulaSyntaxError) return { rows: [], problem: { message: error.message, position: error.position } as Problem };
      throw error;
    }
  }, [expression, fields, previewRows, timeZone]);

  useEffect(() => {
    if (expression.trim() === "") return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      checkFormula(tableId, expression, fieldId, controller.signal).then(
        (result) => {
          setServerCheck({ expression, result });
          if (result.ok) setValue("resultType", result.resultType, { shouldDirty: true });
        },
        () => undefined,
      );
    }, CHECK_DELAY_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [tableId, fieldId, expression, setValue]);

  const checked = serverCheck?.expression === expression ? serverCheck.result : null;
  const problem: Problem | null = local?.problem ?? (checked && !checked.ok ? checked.error : null);
  const resultType: FormulaResultType | null = checked?.ok ? checked.resultType : null;
  const format = useMemo(
    () => createCellFormatter({ id: "preview", name: "Preview", type: "formula", expression: "", resultType: resultType ?? "text" }, { locale, timeZone, labelOf: () => undefined }),
    [resultType, locale, timeZone],
  );
  const expressionError = (formState.errors as { expression?: { message?: string } }).expression?.message;

  return (
    <div className="flex flex-col gap-3">
      <label className={labelClass}>
        Formula
        <textarea
          {...register("expression")}
          rows={3}
          spellCheck={false}
          aria-invalid={problem !== null || expressionError !== undefined}
          aria-describedby="formula-problem"
          placeholder='IF({Status} = "Done", {Price} * {Qty}, 0)'
          className={`${inputClass} h-auto py-1.5 font-mono`}
        />
      </label>
      <div id="formula-problem" aria-live="polite" className="flex flex-col gap-1">
        {problem && (
          <>
            <ErrorText>{problem.message}</ErrorText>
            {/* The formula with the failing spot underlined, so a position is easy to find. */}
            <pre aria-hidden className="overflow-x-auto rounded bg-zinc-50 px-2 py-1 font-mono text-xs whitespace-pre-wrap dark:bg-zinc-950">
              {expression.slice(0, problem.position)}
              <span className="bg-red-100 text-red-700 underline decoration-red-600 decoration-wavy dark:bg-red-950 dark:text-red-300">
                {expression.slice(problem.position, problem.position + 1) || " "}
              </span>
              {expression.slice(problem.position + 1)}
            </pre>
          </>
        )}
        {!problem && <ErrorText>{expressionError}</ErrorText>}
        {!problem && resultType && <span className="text-xs text-zinc-500">Result type: {resultType}</span>}
      </div>

      {!problem && local && local.rows.length > 0 && (
        <table className="text-sm">
          <caption className="mb-1 text-left text-xs text-zinc-500">Preview on the first {local.rows.length} rows</caption>
          <tbody>
            {local.rows.map((row, index) => (
              <tr key={row.rowId} className="border-t border-zinc-100 dark:border-zinc-800">
                <th scope="row" className="w-10 py-0.5 pr-2 text-left font-normal text-zinc-400">
                  {index + 1}
                </th>
                <td className="py-0.5 font-mono text-xs">{"error" in row ? <span className="text-red-600">{row.error}</span> : format(row.value) || <span className="text-zinc-400">empty</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <details className="text-xs text-zinc-500">
        <summary className="cursor-pointer">Fields and functions</summary>
        <p className="mt-1">
          Fields go in braces: <code>{"{Price} * {Qty}"}</code>. Functions: {Object.keys(FUNCTIONS).sort().join(", ")}. Operators: + − * / &amp; = != &lt; &lt;= &gt; &gt;=.
        </p>
      </details>
    </div>
  );
}
