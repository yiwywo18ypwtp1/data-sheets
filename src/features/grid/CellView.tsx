import type { CellValue } from "@/lib/domain/cell";
import type { Field } from "@/lib/domain/field";
import type { CellFormatter } from "@/lib/format";

type CellViewProps = {
  field: Field;
  value: CellValue | undefined;
  /** A formula error for this cell (`#DIV/0! Division by zero`), shown instead of a value. */
  error?: string;
  format: CellFormatter;
  labelOf: (rowId: string) => string | undefined;
};

function Pill({ label, color }: { label: string; color?: string }) {
  return (
    <span
      className="inline-block max-w-full truncate rounded-full px-2 py-px text-xs leading-5"
      style={{ backgroundColor: color ? `${color}22` : undefined, color: color ?? undefined }}
    >
      {label}
    </span>
  );
}

const NUMERIC = new Set(["number", "currency"]);

/** Read-only display of one cell. Purely presentational: no data access, no state. */
export function CellView({ field, value, error, format, labelOf }: CellViewProps) {
  if (error) {
    const [code] = error.split(" ");
    return (
      <span className="font-mono text-xs text-red-600 dark:text-red-400" title={error}>
        {code}
      </span>
    );
  }

  switch (field.type) {
    case "checkbox":
      return value === true ? (
        <span aria-label="Checked" className="text-blue-600">
          ✓
        </span>
      ) : (
        <span aria-label="Not checked" />
      );

    case "singleSelect":
    case "multiSelect": {
      const ids = Array.isArray(value) ? value : value ? [String(value)] : [];
      return (
        <span className="flex gap-1 overflow-hidden">
          {ids.map((id) => {
            const option = field.options.find((candidate) => candidate.id === id);
            return option ? <Pill key={id} label={option.label} color={option.color} /> : null;
          })}
        </span>
      );
    }

    case "link":
      return (
        <span className="flex gap-1 overflow-hidden">
          {(Array.isArray(value) ? value : []).map((id) => (
            <Pill key={id} label={labelOf(id) ?? "…"} color="#2563eb" />
          ))}
        </span>
      );

    case "url":
      return typeof value === "string" ? (
        // Only http(s) URLs can be stored (see cellValueSchemaFor), so this can't run a script.
        <a href={value} target="_blank" rel="noreferrer noopener" className="truncate text-blue-600 underline-offset-2 hover:underline">
          {value}
        </a>
      ) : null;

    default: {
      const numeric = NUMERIC.has(field.type) || (field.type === "formula" && field.resultType === "number");
      // w-full: inside the flex cell a span is only as wide as its text, so text-right would do nothing.
      return <span className={`w-full truncate ${numeric ? "text-right tabular-nums" : ""}`}>{format(value)}</span>;
    }
  }
}
