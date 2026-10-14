import { zodResolver } from "@hookform/resolvers/zod";
import { useMemo } from "react";
import { useFieldArray, useForm, useWatch, type Control, type FieldErrors, type UseFormRegister } from "react-hook-form";
import type { Field } from "@/lib/domain/field";
import { newId } from "@/lib/domain/ids";
import { inferType, isImportable, mappingSchemaFor, NEW_FIELD_TYPE_LABELS, NEW_FIELD_TYPES, type ColumnMapping, type MappingForm } from "@/lib/import/mapping";
import { buttonClass, inputClass, primaryButtonClass, selectClass } from "./styles";
import type { ParsedCsv } from "./UploadStep";

type MappingStepProps = {
  csv: ParsedCsv;
  fields: Field[];
  /** Every column's sample values, for "e.g." hints and type inference. */
  sample: (column: number) => string[];
  initial: ColumnMapping[];
  locale: string;
  timeZone: string;
  onBack: () => void;
  onNext: (mapping: ColumnMapping[]) => void;
};

/**
 * Step 2: where each CSV column goes. One React Hook Form with a `useFieldArray` over
 * the CSV columns; each entry is a discriminated union (skip / existing field / new
 * field). Changing the action replaces the entry, so a column never carries the
 * settings of another action. The table-wide rules (two columns into one field,
 * duplicate new names) come from the shared mapping schema.
 */
export function MappingStep({ csv, fields, sample, initial, locale, timeZone, onBack, onNext }: MappingStepProps) {
  const schema = useMemo(() => mappingSchemaFor(fields), [fields]);
  const form = useForm<MappingForm>({ resolver: zodResolver(schema), defaultValues: { columns: initial } });
  const { fields: rows } = useFieldArray({ control: form.control, name: "columns" });
  const columns = useWatch({ control: form.control, name: "columns" });
  const errors = form.formState.errors;
  const importable = fields.filter(isImportable);

  function changeAction(index: number, action: ColumnMapping["action"]) {
    const header = csv.headers[index];
    const next: ColumnMapping =
      action === "skip"
        ? { action }
        : action === "existing"
          ? { action, fieldId: importable.find((field) => field.name.toLowerCase() === header.toLowerCase())?.id ?? "" }
          : { action, newFieldId: newId("fld"), name: header, type: inferType(sample(index), { locale, timeZone }) };
    form.setValue(`columns.${index}`, next, { shouldDirty: true });
    // A nested value without registered inputs: validate the whole form (see the view panel).
    if (form.formState.isSubmitted) void form.trigger();
  }

  return (
    <form noValidate onSubmit={form.handleSubmit(({ columns: mapping }) => onNext(mapping))} className="flex min-h-0 flex-col gap-3">
      <h2 className="font-semibold">2. Map columns to fields</h2>
      <div className="min-h-0 overflow-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-white text-left text-zinc-500 dark:bg-zinc-950">
            <tr>
              <th scope="col" className="py-1 pr-3 font-normal">
                CSV column
              </th>
              <th scope="col" className="py-1 pr-3 font-normal">
                Import as
              </th>
              <th scope="col" className="py-1 font-normal">
                Field
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <MappingRow
                key={row.id}
                index={index}
                header={csv.headers[index]}
                examples={sample(index).filter(Boolean).slice(0, 3)}
                column={columns[index]}
                importable={importable}
                usedFieldIds={columns.flatMap((column, other) => (other !== index && column.action === "existing" ? [column.fieldId] : []))}
                control={form.control}
                register={form.register}
                errors={errors}
                onAction={(action) => changeAction(index, action)}
              />
            ))}
          </tbody>
        </table>
      </div>
      {errors.columns?.root?.message || errors.columns?.message ? (
        <p role="alert" className="text-sm text-red-600">
          {errors.columns?.root?.message ?? errors.columns?.message}
        </p>
      ) : null}
      <div className="flex gap-2">
        <button type="button" className={buttonClass} onClick={onBack}>
          Back
        </button>
        <button type="submit" className={`${primaryButtonClass} ml-auto`}>
          Next: check values
        </button>
      </div>
    </form>
  );
}

type MappingRowProps = {
  index: number;
  header: string;
  examples: string[];
  column: ColumnMapping;
  importable: Field[];
  usedFieldIds: string[];
  control: Control<MappingForm>;
  register: UseFormRegister<MappingForm>;
  errors: FieldErrors<MappingForm>;
  onAction: (action: ColumnMapping["action"]) => void;
};

function MappingRow({ index, header, examples, column, importable, usedFieldIds, register, errors, onAction }: MappingRowProps) {
  const rowErrors = errors.columns?.[index] as Record<string, { message?: string } | undefined> | undefined;
  const error = rowErrors?.fieldId?.message ?? rowErrors?.name?.message ?? rowErrors?.type?.message;
  return (
    <tr className="border-t border-zinc-100 align-top dark:border-zinc-800">
      <th scope="row" className="py-1.5 pr-3 text-left font-medium">
        {header}
        {examples.length > 0 && <div className="max-w-64 truncate text-xs font-normal text-zinc-500">e.g. {examples.join(", ")}</div>}
      </th>
      <td className="py-1.5 pr-3">
        <select aria-label={`Import ${header} as`} className={selectClass} value={column.action} onChange={(event) => onAction(event.target.value as ColumnMapping["action"])}>
          <option value="existing">Existing field</option>
          <option value="new">New field</option>
          <option value="skip">Skip</option>
        </select>
      </td>
      <td className="py-1.5">
        <div className="flex flex-wrap items-center gap-2">
          {column.action === "existing" && (
            <select aria-label={`Field for ${header}`} aria-invalid={error ? true : undefined} className={selectClass} {...register(`columns.${index}.fieldId`)}>
              <option value="">Pick a field…</option>
              {importable.map((field) => (
                <option key={field.id} value={field.id} disabled={usedFieldIds.includes(field.id)}>
                  {field.name}
                </option>
              ))}
            </select>
          )}
          {column.action === "new" && (
            <>
              <input aria-label={`Name of the new field for ${header}`} aria-invalid={error ? true : undefined} className={inputClass} {...register(`columns.${index}.name`)} />
              <select aria-label={`Type of the new field for ${header}`} className={selectClass} {...register(`columns.${index}.type`)}>
                {NEW_FIELD_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {NEW_FIELD_TYPE_LABELS[type]}
                  </option>
                ))}
              </select>
            </>
          )}
          {column.action === "skip" && <span className="text-zinc-400">Not imported</span>}
        </div>
        {error && (
          <span role="alert" className="text-xs text-red-600">
            {error}
          </span>
        )}
      </td>
    </tr>
  );
}
