import type { Field } from "@/lib/domain/field";
import type { RowHeight, View } from "@/lib/domain/view";

export const HEADER_HEIGHT = 34;
export const FOOTER_HEIGHT = 32;
/** Row-number column, pinned left of the primary field. */
export const GUTTER_WIDTH = 52;
export const ROW_HEIGHTS: Record<RowHeight, number> = { short: 32, medium: 56, tall: 88 };

export type GridColumn = { field: Field; width: number };

function defaultWidth(field: Field): number {
  switch (field.type) {
    case "checkbox":
      return 90;
    case "number":
    case "currency":
      return 130;
    case "date":
      return field.includeTime ? 190 : 140;
    case "multiSelect":
    case "link":
    case "lookup":
      return 200;
    default:
      return 180;
  }
}

/**
 * Columns as the view shows them: the primary field first (it's pinned and can't
 * be hidden), then `fieldOrder`, then fields the view doesn't know yet (created
 * after it was saved), minus hidden fields.
 */
export function gridColumns(fields: Field[], primaryFieldId: string, view: Pick<View, "fieldOrder" | "hiddenFieldIds" | "columnWidths">): GridColumn[] {
  const byId = new Map(fields.map((field) => [field.id, field]));
  const ordered = [...view.fieldOrder.filter((id) => byId.has(id)), ...fields.map((field) => field.id).filter((id) => !view.fieldOrder.includes(id))];
  const hidden = new Set(view.hiddenFieldIds);
  const ids = [primaryFieldId, ...ordered.filter((id) => id !== primaryFieldId && !hidden.has(id))];
  return ids.flatMap((id) => {
    const field = byId.get(id);
    return field ? [{ field, width: view.columnWidths[id] ?? (id === primaryFieldId ? 220 : defaultWidth(field)) }] : [];
  });
}
