import { useFieldArray, useFormContext, useFormState, useWatch, type FieldErrors } from "react-hook-form";
import type { Field } from "@/lib/domain/field";
import {
  changeOperator,
  defaultConditionFor,
  filterKindOf,
  OPERATORS_BY_KIND,
  type FilterCondition,
  type FilterOperator,
} from "@/lib/domain/filter";
import type { ViewQuery } from "@/lib/domain/view";
import { controlClass, NumberInput, OptionPicker, RecordPicker, smallButtonClass } from "./inputs";

const MAX_CONDITIONS = 50;
const MAX_GROUPS = 20;

const OPERATOR_LABELS: Record<FilterOperator, string> = {
  contains: "contains",
  is: "is",
  isEmpty: "is empty",
  eq: "=",
  neq: "≠",
  lt: "<",
  gt: ">",
  between: "between",
  before: "is before",
  after: "is after",
  withinLastDays: "is within the last",
  isToday: "is today",
  isChecked: "is checked",
  isNotChecked: "is not checked",
  isAnyOf: "is any of",
  isNoneOf: "is none of",
  hasAnyOf: "has any of",
};

type ConditionPath = `filter.conditions.${number}` | `filter.groups.${number}.conditions.${number}`;
type ConditionsPath = "filter.conditions" | `filter.groups.${number}.conditions`;

export type FilterContext = {
  fields: Field[];
  /** Labels of linked records the grid already knows, for "has any of" chips. */
  labelOf: (rowId: string) => string | undefined;
};

/** The first error message anywhere under `path` (zod puts them on `value.max`, `fieldId`, …). */
function firstError(errors: FieldErrors<ViewQuery>, path: string): string | undefined {
  let node: unknown = errors;
  for (const key of path.split(".")) node = (node as Record<string, unknown> | undefined)?.[key];
  const stack = [node];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== "object") continue;
    if ("message" in current && typeof current.message === "string") return current.message;
    stack.push(...Object.values(current));
  }
  return undefined;
}

function ConditionRow({ path, context, onRemove }: { path: ConditionPath; context: FilterContext; onRemove: () => void }) {
  const { control, setValue, trigger } = useFormContext<ViewQuery>();
  const condition = useWatch({ control, name: path }) as FilterCondition;
  const { errors } = useFormState({ control, name: path });
  const error = firstError(errors, path);
  const field = context.fields.find((candidate) => candidate.id === condition.fieldId);

  // The whole condition is replaced, never patched: an operator's value can't outlive it.
  // Nothing under a condition is a registered input, and RHF drops a nested error (`value.max`)
  // when triggering a path without registered fields, so the whole (small) form is validated.
  const replace = (next: FilterCondition) => {
    setValue(path, next, { shouldDirty: true });
    void trigger();
  };
  const label = field?.name ?? "Deleted field";

  return (
    <li className="flex flex-col gap-0.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <select
          aria-label="Field"
          className={controlClass}
          value={condition.fieldId}
          onChange={(event) => replace(defaultConditionFor(context.fields.find((candidate) => candidate.id === event.target.value)!))}
        >
          {!field && <option value={condition.fieldId}>Deleted field</option>}
          {context.fields.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name}
            </option>
          ))}
        </select>
        {field && (
          <select aria-label={`Operator for ${label}`} className={controlClass} value={condition.operator} onChange={(event) => replace(changeOperator(condition, event.target.value as FilterOperator))}>
            {OPERATORS_BY_KIND[filterKindOf(field)].map((operator) => (
              <option key={operator} value={operator}>
                {OPERATOR_LABELS[operator]}
              </option>
            ))}
          </select>
        )}
        {field && <ConditionValue field={field} condition={condition} onChange={replace} context={context} invalid={error !== undefined} />}
        <button type="button" aria-label={`Remove condition on ${label}`} className={smallButtonClass} onClick={onRemove}>
          ×
        </button>
      </div>
      {error && (
        <span role="alert" className="text-xs text-red-600">
          {error}
        </span>
      )}
    </li>
  );
}

function ConditionValue({
  field,
  condition,
  onChange,
  context,
  invalid,
}: {
  field: Field;
  condition: FilterCondition;
  onChange: (next: FilterCondition) => void;
  context: FilterContext;
  invalid: boolean;
}) {
  const label = `Value for ${field.name}`;
  switch (condition.operator) {
    case "contains":
    case "is":
      return (
        <input
          type={filterKindOf(field) === "date" ? "date" : "text"}
          aria-label={label}
          aria-invalid={invalid || undefined}
          className={`${controlClass} w-40`}
          value={condition.value}
          onChange={(event) => onChange({ ...condition, value: event.target.value })}
        />
      );
    case "before":
    case "after":
      return (
        <input
          type="date"
          aria-label={label}
          aria-invalid={invalid || undefined}
          className={controlClass}
          value={condition.value}
          onChange={(event) => onChange({ ...condition, value: event.target.value as typeof condition.value })}
        />
      );
    case "eq":
    case "neq":
    case "lt":
    case "gt":
      return <NumberInput label={label} invalid={invalid} value={condition.value} onChange={(value) => onChange({ ...condition, value })} />;
    case "between":
      return (
        <>
          <NumberInput label={`${label}: from`} invalid={invalid} value={condition.value.min} onChange={(min) => onChange({ ...condition, value: { ...condition.value, min } })} />
          <span className="text-zinc-500">and</span>
          <NumberInput label={`${label}: to`} invalid={invalid} value={condition.value.max} onChange={(max) => onChange({ ...condition, value: { ...condition.value, max } })} />
        </>
      );
    case "withinLastDays":
      return (
        <>
          <NumberInput label={`${label}: days`} invalid={invalid} value={condition.value} onChange={(value) => onChange({ ...condition, value })} />
          <span className="text-zinc-500">days</span>
        </>
      );
    case "isAnyOf":
    case "isNoneOf":
      return (
        <OptionPicker
          label={label}
          options={field.type === "singleSelect" || field.type === "multiSelect" ? field.options : []}
          value={condition.value}
          onChange={(value) => onChange({ ...condition, value })}
        />
      );
    case "hasAnyOf":
      return field.type === "link" ? (
        <RecordPicker label={label} tableId={field.targetTableId} labelOf={context.labelOf} value={condition.value} onChange={(value) => onChange({ ...condition, value })} />
      ) : null;
    default:
      return null;
  }
}

function Conjunction({ name, label }: { name: "filter.conjunction" | `filter.groups.${number}.conjunction`; label: string }) {
  const { register } = useFormContext<ViewQuery>();
  return (
    <label className="flex items-center gap-1.5 text-sm text-zinc-600 dark:text-zinc-300">
      {label}
      <select className={controlClass} {...register(name)}>
        <option value="and">all</option>
        <option value="or">any</option>
      </select>
      of these conditions
    </label>
  );
}

function ConditionList({ name, context }: { name: ConditionsPath; context: FilterContext }) {
  const { control } = useFormContext<ViewQuery>();
  const { fields: rows, append, remove } = useFieldArray({ control, name });
  return (
    <>
      <ul className="flex flex-col gap-1.5">
        {rows.map((row, index) => (
          <ConditionRow key={row.id} path={`${name}.${index}`} context={context} onRemove={() => remove(index)} />
        ))}
      </ul>
      <button
        type="button"
        className={`${smallButtonClass} self-start`}
        disabled={rows.length >= MAX_CONDITIONS || context.fields.length === 0}
        onClick={() => append(defaultConditionFor(context.fields[0]))}
      >
        + Add condition
      </button>
    </>
  );
}

/**
 * The filter tree: root conditions and groups of conditions, two levels at most
 * (the schema's shape enforces it). Each level is its own `useFieldArray`.
 */
export function FilterFields({ context }: { context: FilterContext }) {
  const { control } = useFormContext<ViewQuery>();
  const { fields: groups, append, remove } = useFieldArray({ control, name: "filter.groups" });

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-sm font-semibold">Filter</legend>
      <Conjunction name="filter.conjunction" label="Show records that match" />
      <ConditionList name="filter.conditions" context={context} />
      {groups.map((group, index) => (
        <div key={group.id} role="group" aria-label={`Condition group ${index + 1}`} className="flex flex-col gap-1.5 rounded border border-zinc-200 p-2 dark:border-zinc-800">
          <div className="flex items-center gap-2">
            <Conjunction name={`filter.groups.${index}.conjunction`} label="Group: match" />
            <button type="button" className={`${smallButtonClass} ml-auto`} onClick={() => remove(index)}>
              Remove group
            </button>
          </div>
          <ConditionList name={`filter.groups.${index}.conditions`} context={context} />
        </div>
      ))}
      <button
        type="button"
        className={`${smallButtonClass} self-start`}
        disabled={groups.length >= MAX_GROUPS || context.fields.length === 0}
        onClick={() => append({ conjunction: "or", conditions: [defaultConditionFor(context.fields[0])] })}
      >
        + Add condition group
      </button>
    </fieldset>
  );
}
