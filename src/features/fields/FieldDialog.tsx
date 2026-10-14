"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useMemo } from "react";
import { FormProvider, useFieldArray, useForm, useFormContext, useWatch } from "react-hook-form";
import type { Field, FieldType } from "@/lib/domain/field";
import { newId } from "@/lib/domain/ids";
import type { Row } from "@/lib/domain/row";
import { ApiRequestError } from "@/features/grid/api";
import { createField, updateField } from "./api";
import { Dialog, ErrorText, inputClass, labelClass, primaryButtonClass, secondaryButtonClass } from "./Dialog";
import { FIELD_TYPE_LABELS, fieldDefaults, fieldFormSchema, OPTION_COLORS, toFormValues } from "./fieldForm";
import { ConversionPreview, changesValues } from "./ConversionPreview";
import { FormulaEditor } from "./FormulaEditor";

export type BaseTable = { id: string; name: string; fields: Field[] };

type FieldDialogProps = {
  tableId: string;
  /** Every table of the base, this one included: link targets and lookup fields come from them. */
  tables: BaseTable[];
  /** The field to edit, or null to create one. */
  field: Field | null;
  previewRows: Row[];
  locale: string;
  timeZone: string;
  onClose: () => void;
  onSaved: (field: Field) => void;
};

const TYPES = Object.keys(FIELD_TYPE_LABELS) as FieldType[];

/** "" from an empty number input means "not set", not 0. */
const optionalNumber = (value: unknown) => (value === "" || value === null || value === undefined || Number.isNaN(value) ? undefined : Number(value));
const optionalText = (value: unknown) => (typeof value === "string" && value.trim() !== "" ? value.trim() : undefined);

/**
 * Create or edit a field: one React Hook Form over the `Field` discriminated union,
 * validated with the shared field schema (plus unique names). Changing the type resets
 * the form to that type's defaults, so no setting of the old type is sent. Server
 * errors (a cycle, a bad lookup) land on the form fields they name.
 *
 * Editing can change the type or settings that rewrite values (date ↔ date-time, one link
 * instead of several, removed options); the conversion preview shows what happens to the
 * values before "Convert field". Only a link's table can't change.
 */
export function FieldDialog({ tableId, tables, field, previewRows, locale, timeZone, onClose, onSaved }: FieldDialogProps) {
  const table = tables.find((candidate) => candidate.id === tableId)!;
  const editing = field !== null;
  const others = useMemo(() => table.fields.filter((candidate) => candidate.id !== field?.id), [table.fields, field]);
  const schema = useMemo(() => fieldFormSchema(others), [others]);
  const context = useMemo(
    () => ({ tableIds: tables.filter((candidate) => candidate.id !== tableId).map((candidate) => candidate.id), linkFieldIds: table.fields.filter((candidate) => candidate.type === "link").map((candidate) => candidate.id) }),
    [tables, tableId, table.fields],
  );
  const form = useForm<Field>({
    resolver: zodResolver(schema),
    defaultValues: field ? toFormValues(field, table.fields) : fieldDefaults("text", { id: newId("fld"), name: "" }, context),
  });
  const type = useWatch({ control: form.control, name: "type" });
  const name = useWatch({ control: form.control, name: "name" });
  const { errors, isSubmitting } = form.formState;
  const watched = useWatch({ control: form.control }) as Field;
  const converts = field !== null && changesValues(field, watched);

  // For the formula preview: the table's fields with this one as currently typed.
  const formulaFields = useMemo(() => [...others, { id: form.getValues("id"), name: name || " ", type: "text" } as Field], [others, form, name]);

  const submit = form.handleSubmit(async (values) => {
    try {
      const { field: saved } = editing ? await updateField(tableId, values, { locale, timeZone }) : await createField(tableId, values);
      onSaved(saved);
    } catch (error) {
      if (!(error instanceof ApiRequestError)) return form.setError("root", { message: "Couldn't save the field" });
      for (const [key, message] of Object.entries(error.fieldErrors ?? {})) form.setError(key as keyof Field, { message });
      form.setError("root", { message: error.message });
    }
  });

  return (
    <Dialog title={editing ? `Edit field “${field.name}”` : "New field"} onClose={onClose} wide={type === "formula"}>
      <FormProvider {...form}>
        <form noValidate onSubmit={(event) => void submit(event)} className="flex flex-col gap-3">
          <label className={labelClass}>
            Name
            <input autoFocus className={inputClass} aria-invalid={errors.name ? true : undefined} {...form.register("name")} />
            <ErrorText>{errors.name?.message}</ErrorText>
          </label>
          <label className={labelClass}>
            Type
            <select
              aria-label="Type"
              className={inputClass}
              value={type}
              onChange={(event) =>
                form.reset(fieldDefaults(event.target.value as FieldType, { id: form.getValues("id"), name: form.getValues("name") }, context), { keepDefaultValues: true })
              }
            >
              {TYPES.map((candidate) => (
                <option key={candidate} value={candidate}>
                  {FIELD_TYPE_LABELS[candidate]}
                </option>
              ))}
            </select>

          </label>

          <TypeSettings type={type} editing={editing} tableId={tableId} tables={tables} />
          {type === "formula" && (
            <FormulaEditor tableId={tableId} fieldId={field?.id} fields={formulaFields} previewRows={previewRows} locale={locale} timeZone={timeZone} />
          )}

          {field && <ConversionPreview tableId={tableId} original={field} locale={locale} timeZone={timeZone} />}
          <ErrorText>{errors.root?.message}</ErrorText>
          <div className="flex justify-end gap-2">
            <button type="button" className={secondaryButtonClass} onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className={primaryButtonClass} disabled={isSubmitting}>
              {isSubmitting ? "Saving…" : !editing ? "Create field" : converts ? "Convert field" : "Save"}
            </button>
          </div>
        </form>
      </FormProvider>
    </Dialog>
  );
}

/** Inputs for the settings of one field type. Registered paths exist only on that member of the union. */
function TypeSettings({ type, editing, tableId, tables }: { type: FieldType; editing: boolean; tableId: string; tables: BaseTable[] }) {
  const { register, formState, control } = useFormContext<Field>();
  const errors = formState.errors as Record<string, { message?: string } | undefined>;
  const linkFieldId = useWatch({ control, name: "linkFieldId" }) as string | undefined;
  const table = tables.find((candidate) => candidate.id === tableId)!;

  switch (type) {
    case "text":
      return (
        <label className={labelClass}>
          Maximum length (optional)
          <input type="number" min={1} className={inputClass} {...register("maxLength", { setValueAs: optionalNumber })} />
          <ErrorText>{errors.maxLength?.message}</ErrorText>
        </label>
      );
    case "number":
      return (
        <div className="grid grid-cols-3 gap-2">
          <label className={labelClass}>
            Decimals
            <select aria-label="Decimals" className={inputClass} {...register("precision", { setValueAs: Number })}>
              {[0, 1, 2, 3, 4].map((digits) => (
                <option key={digits} value={digits}>
                  {digits}
                </option>
              ))}
            </select>
          </label>
          <label className={labelClass}>
            Min
            <input type="number" step="any" className={inputClass} {...register("min", { setValueAs: optionalNumber })} />
          </label>
          <label className={labelClass}>
            Max
            <input type="number" step="any" className={inputClass} aria-invalid={errors.max ? true : undefined} {...register("max", { setValueAs: optionalNumber })} />
            <ErrorText>{errors.max?.message}</ErrorText>
          </label>
        </div>
      );
    case "currency":
      return (
        <label className={labelClass}>
          Currency (ISO code)
          <input list="currency-codes" className={inputClass} aria-invalid={errors.currency ? true : undefined} {...register("currency", { setValueAs: (value: string) => value.trim().toUpperCase() })} />
          <datalist id="currency-codes">
            {Intl.supportedValuesOf("currency").map((code) => (
              <option key={code} value={code} />
            ))}
          </datalist>
          <ErrorText>{errors.currency?.message}</ErrorText>
        </label>
      );
    case "date":
      return (
        <div className="flex flex-col gap-2">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" {...register("includeTime")} />
            Include time
          </label>
          <label className={labelClass}>
            Time zone (optional; empty shows each viewer their own)
            <input list="time-zones" className={inputClass} aria-invalid={errors.timeZone ? true : undefined} {...register("timeZone", { setValueAs: optionalText })} />
            <datalist id="time-zones">
              {Intl.supportedValuesOf("timeZone").map((zone) => (
                <option key={zone} value={zone} />
              ))}
            </datalist>
            <ErrorText>{errors.timeZone?.message}</ErrorText>
          </label>
        </div>
      );
    case "singleSelect":
    case "multiSelect":
      return <OptionsEditor />;
    case "link":
      return (
        <div className="flex flex-col gap-2">
          <label className={labelClass}>
            Linked table
            <select aria-label="Linked table" className={inputClass} disabled={editing} {...register("targetTableId")}>
              {tables.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" {...register("multiple")} />
            Allow linking to several records
          </label>
        </div>
      );
    case "lookup": {
      const links = table.fields.filter((candidate) => candidate.type === "link");
      const link = links.find((candidate) => candidate.id === linkFieldId);
      const target = link?.type === "link" ? tables.find((candidate) => candidate.id === link.targetTableId) : undefined;
      if (links.length === 0) return <ErrorText>Add a link field first: a lookup shows values of linked records.</ErrorText>;
      return (
        <div className="grid grid-cols-2 gap-2">
          <label className={labelClass}>
            Through link
            <select aria-label="Through link" className={inputClass} {...register("linkFieldId")}>
              {links.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </option>
              ))}
            </select>
          </label>
          <label className={labelClass}>
            Field to show
            <select aria-label="Field to show" className={inputClass} aria-invalid={errors.targetFieldId ? true : undefined} {...register("targetFieldId")}>
              <option value="">Pick a field…</option>
              {target?.fields.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </option>
              ))}
            </select>
            <ErrorText>{errors.targetFieldId?.message}</ErrorText>
          </label>
        </div>
      );
    }
    default:
      return null;
  }
}

/** Select options. Removing one that's in use empties those cells (the conversion preview counts them). */
function OptionsEditor() {
  const { control, register, formState } = useFormContext<Field>();
  const { fields: rows, append, remove } = useFieldArray({ control, name: "options" as never });
  const errors = (formState.errors as { options?: ({ label?: { message?: string } } | undefined)[] & { message?: string } }).options;

  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1 text-sm">Options</legend>
      {rows.map((row, index) => {
        return (
          <div key={row.id} className="flex flex-col gap-0.5">
            <div className="flex items-center gap-2">
              <input type="color" aria-label={`Colour of option ${index + 1}`} className="h-8 w-8 rounded border border-zinc-300 dark:border-zinc-700" {...register(`options.${index}.color` as never)} />
              <input aria-label={`Option ${index + 1}`} className={`${inputClass} flex-1`} {...register(`options.${index}.label` as never)} />
              <button
                type="button"
                aria-label={`Remove option ${index + 1}`}
                className={secondaryButtonClass}
                onClick={() => remove(index)}
              >
                ×
              </button>
            </div>
            <ErrorText>{errors?.[index]?.label?.message}</ErrorText>
          </div>
        );
      })}
      <ErrorText>{errors?.message}</ErrorText>
      <button
        type="button"
        className={`${secondaryButtonClass} self-start`}
        onClick={() => append({ id: newId("opt"), label: "", color: OPTION_COLORS[rows.length % OPTION_COLORS.length] } as never)}
      >
        + Add option
      </button>
    </fieldset>
  );
}
