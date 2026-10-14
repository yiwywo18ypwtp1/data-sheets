import type { Field, FormulaResultType } from "@/lib/domain/field";
import { request } from "@/features/grid/api";

/** Client calls for schema changes. Formulas are sent with field names; the server stores ids. */

export function createField(tableId: string, field: Field) {
  return request<{ field: Field }>(`/api/tables/${tableId}/fields`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(field),
  });
}

type Viewer = { locale: string; timeZone: string };
const viewerParams = ({ locale, timeZone }: Viewer) => new URLSearchParams({ locale, tz: timeZone });

/** Text values convert as the viewer reads them ("1 234,5", "12.03.2026"), so their locale and zone go along. */
export function updateField(tableId: string, field: Field, viewer: Viewer) {
  return request<{ field: Field }>(`/api/tables/${tableId}/fields/${field.id}?${viewerParams(viewer)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(field),
  });
}

export type FieldDependent = { id: string; name: string; tableId: string };

/** Without `force`, a field other fields read is not deleted: the error's details list them (409). */
export async function deleteField(tableId: string, fieldId: string, force: boolean): Promise<void> {
  await request<null>(`/api/tables/${tableId}/fields/${fieldId}${force ? "?force=1" : ""}`, { method: "DELETE" });
}

export type FormulaCheck =
  | { ok: true; resultType: FormulaResultType; dependencies: { id: string; name: string }[] }
  | { ok: false; error: { message: string; position: number } };

export function checkFormula(tableId: string, expression: string, fieldId: string | undefined, signal: AbortSignal) {
  return request<FormulaCheck>("/api/formula/check", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tableId, expression, fieldId }),
    signal,
  });
}

export type ConversionPreview = {
  total: number;
  converted: number;
  emptied: number;
  examples: { from: string; to: string }[];
  failures: { from: string; reason: string }[];
  newOptions: string[];
};

/** What saving `field` would do to the stored values; nothing is changed. */
export async function previewFieldChange(tableId: string, field: Field, viewer: Viewer, signal: AbortSignal): Promise<ConversionPreview> {
  const params = viewerParams(viewer);
  params.set("preview", "1");
  const { preview } = await request<{ preview: ConversionPreview }>(`/api/tables/${tableId}/fields/${field.id}?${params}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(field),
    signal,
  });
  return preview;
}
