import type { CellValue } from "@/lib/domain/cell";
import type { Field } from "@/lib/domain/field";
import { toEditText } from "@/lib/format";
import { useGridEditing } from "../GridEditingContext";
import { LinkEditor } from "./LinkEditor";
import { SelectEditor } from "./SelectEditor";
import { TextEditor } from "./TextEditor";

type CellEditorProps = {
  field: Field;
  value: CellValue | undefined;
  /** The character that started editing (replaces the value), or null to edit the current value. */
  initialText: string | null;
};

/** Picks the editor for a field type. Checkboxes toggle without an editor; computed fields aren't editable. */
export function CellEditor({ field, value, initialText }: CellEditorProps) {
  const { store, locale, timeZone } = useGridEditing();
  switch (field.type) {
    case "singleSelect":
    case "multiSelect":
      return <SelectEditor field={field} value={value} initialQuery={initialText ?? ""} />;
    case "link":
      return <LinkEditor field={field} value={value} initialQuery={initialText ?? ""} />;
    case "checkbox":
    case "lookup":
    case "formula":
      return null;
    default:
      return <TextEditor field={field} initialText={initialText ?? toEditText(field, value, { locale, timeZone, labelOf: store.getLabel })} />;
  }
}
