import { beforeEach, describe, expect, it, vi } from "vitest";
import * as historyRoute from "@/app/api/tables/[id]/rows/[rowId]/history/route";
import * as rowRoute from "@/app/api/tables/[id]/rows/[rowId]/route";
import type { CellHistoryResponse } from "@/lib/domain/api";
import { deleteField } from "./fields";
import { applyRowBatch } from "./rowWrites";
import { getRowsByIds } from "./rows";
import { BASE_ID, TABLE_IDS } from "./seed";

let userId = "usr_editor";
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === "ds_user" ? { value: userId } : undefined) }),
}));
beforeEach(() => {
  userId = "usr_editor";
});

const orders = { id: TABLE_IDS.orders, baseId: BASE_ID };
const eddie = { userId: "usr_editor", name: "Eddie Editor", clientId: null };
const cora = { userId: "usr_creator", name: "Cora Creator", clientId: null };

const rev = (rowId: string) => getRowsByIds(TABLE_IDS.orders, [rowId])[0].rev;
const update = (rowId: string, values: Record<string, unknown>, origin = eddie) =>
  applyRowBatch(orders, [{ op: "update", rowId, values: values as never, rev: rev(rowId) }], origin)[0];

async function history(rowId: string, query = ""): Promise<{ status: number; body: CellHistoryResponse }> {
  const response = await historyRoute.GET(new Request(`http://localhost/api/tables/tbl_orders/rows/${rowId}/history?${query}`), {
    params: Promise.resolve({ id: TABLE_IDS.orders, rowId }),
  });
  return { status: response.status, body: (await response.json()) as CellHistoryResponse };
}

describe("cell history", () => {
  it("logs each written cell with the value it replaced, the author and the row revision", async () => {
    const rowId = "row_o_000010";
    const before = getRowsByIds(TABLE_IDS.orders, [rowId])[0].values.fld_o_notes ?? null;
    update(rowId, { fld_o_notes: "first" });
    update(rowId, { fld_o_notes: "second", fld_o_qty: 9 }, cora);

    const { body } = await history(rowId);
    expect(body.entries.map((entry) => [entry.fieldId, entry.before, entry.after, entry.by.name])).toEqual([
      // Newest first; one entry per cell of the second write, then the first write.
      ["fld_o_qty", expect.anything(), 9, "Cora Creator"],
      ["fld_o_notes", "first", "second", "Cora Creator"],
      ["fld_o_notes", before, "first", "Eddie Editor"],
    ]);
    expect(body.entries[0].rev).toBe(rev(rowId));
    // Recomputed formulas (Subtotal, Total) aren't logged: they follow from Qty.
    expect(body.entries.some((entry) => entry.fieldId === "fld_o_subtotal")).toBe(false);
  });

  it("doesn't log a write of the same value or a rejected one", async () => {
    const rowId = "row_o_000011";
    update(rowId, { fld_o_notes: "same" });
    update(rowId, { fld_o_notes: "same" });
    const rejected = update(rowId, { fld_o_rating: 99 }); // the field's max is 5
    expect(rejected.ok).toBe(false);

    const { body } = await history(rowId);
    expect(body.entries).toHaveLength(1);
  });

  it("filters by field and pages back with `before`", async () => {
    const rowId = "row_o_000012";
    for (let i = 1; i <= 5; i++) update(rowId, { fld_o_weight: i, fld_o_coupon: `C${i}` });

    const first = await history(rowId, "fieldId=fld_o_weight&limit=2");
    expect(first.body.entries.map((entry) => entry.after)).toEqual([5, 4]);
    const second = await history(rowId, `fieldId=fld_o_weight&limit=2&before=${first.body.next}`);
    expect(second.body.entries.map((entry) => entry.after)).toEqual([3, 2]);
    const last = await history(rowId, `fieldId=fld_o_weight&limit=2&before=${second.body.next}`);
    expect(last.body.entries.map((entry) => entry.after)).toEqual([1]);
    expect(last.body.next).toBeNull();
  });

  it("labels linked records in link values", async () => {
    const rowId = "row_o_000013";
    const customer = "row_c_00002";
    update(rowId, { fld_o_customer: [customer] });
    const { body } = await history(rowId, "fieldId=fld_o_customer");
    expect(body.entries[0].after).toEqual([customer]);
    expect(body.linkedLabels[customer]).toEqual(expect.any(String));
  });

  it("answers 404 for a record that never existed and drops a deleted field's history", async () => {
    expect((await history("row_nope")).status).toBe(404);

    const rowId = "row_o_000014";
    update(rowId, { fld_o_invoice: "INV-1" });
    deleteField(TABLE_IDS.orders, "fld_o_invoice", true);
    const { body } = await history(rowId);
    expect(body.entries.some((entry) => entry.fieldId === "fld_o_invoice")).toBe(false);
  });

  it("GET /rows/:rowId returns one record with its link labels", async () => {
    const response = await rowRoute.GET(new Request("http://localhost/api/tables/tbl_orders/rows/row_o_000001"), {
      params: Promise.resolve({ id: TABLE_IDS.orders, rowId: "row_o_000001" }),
    });
    const body = (await response.json()) as { row: { id: string }; linkedLabels: Record<string, string> };
    expect(body.row.id).toBe("row_o_000001");
    expect(Object.keys(body.linkedLabels).length).toBeGreaterThan(0);
  });
});
