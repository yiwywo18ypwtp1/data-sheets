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

export function updateField(tableId: string, field: Field) {
  return request<{ field: Field }>(`/api/tables/${tableId}/fields/${field.id}`, {
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
