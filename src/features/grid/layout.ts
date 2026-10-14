import type { Field } from "@/lib/domain/field";
import { MAX_COLUMN_WIDTH, MIN_COLUMN_WIDTH, type RowHeight, type View } from "@/lib/domain/view";

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

/** The parts of a view the grid changes directly (saved at once, without the view panel's save/reset). */
export type ViewLayout = Pick<View, "fieldOrder" | "hiddenFieldIds" | "columnWidths">;

/** Every field id in display order, including hidden ones and fields the view doesn't list yet. */
function fullOrder(fields: Field[], layout: ViewLayout): string[] {
  const ids = new Set(fields.map((field) => field.id));
  const listed = layout.fieldOrder.filter((id) => ids.has(id));
  return [...listed, ...fields.map((field) => field.id).filter((id) => !listed.includes(id))];
}

/** Moves a field one place left or right among the visible, non-primary columns. */
export function moveField(fields: Field[], primaryFieldId: string, layout: ViewLayout, fieldId: string, direction: -1 | 1): ViewLayout {
  const order = fullOrder(fields, layout);
  const visible = order.filter((id) => id !== primaryFieldId && !layout.hiddenFieldIds.includes(id));
  const from = visible.indexOf(fieldId);
  const neighbour = visible[from + direction];
  if (from === -1 || neighbour === undefined) return layout;
  const a = order.indexOf(fieldId);
  const b = order.indexOf(neighbour);
  [order[a], order[b]] = [order[b], order[a]];
  return { ...layout, fieldOrder: order };
}

export function setFieldHidden(layout: ViewLayout, fieldId: string, hidden: boolean): ViewLayout {
  const others = layout.hiddenFieldIds.filter((id) => id !== fieldId);
  return { ...layout, hiddenFieldIds: hidden ? [...others, fieldId] : others };
}

export function setColumnWidth(layout: ViewLayout, fieldId: string, width: number): ViewLayout {
  const clamped = Math.round(Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, width)));
  return { ...layout, columnWidths: { ...layout.columnWidths, [fieldId]: clamped } };
}
