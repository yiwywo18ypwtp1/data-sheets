import { describe, expect, it, vi } from "vitest";
import Papa from "papaparse";
import * as exportRoute from "@/app/api/tables/[id]/export/route";
import * as rowsRoute from "@/app/api/tables/[id]/rows/route";
import { encodeFilterParam } from "@/lib/domain/query";
import { applyRowBatch } from "./rowWrites";
import { BASE_ID, TABLE_IDS } from "./seed";

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: "usr_viewer" }) }) }));

const params = { params: Promise.resolve({ id: TABLE_IDS.orders }) };
const exportOf = (query: string) => exportRoute.GET(new Request(`http://localhost/api/tables/tbl_orders/export?${query}`), params);

async function csv(query: string): Promise<{ response: Response; bytes: Uint8Array; rows: string[][] }> {
  const response = await exportOf(query);
  const bytes = new Uint8Array(await response.arrayBuffer());
  // TextDecoder drops the byte order mark, as a spreadsheet would.
  return { response, bytes, rows: Papa.parse<string[]>(new TextDecoder().decode(bytes), { skipEmptyLines: true }).data };
}

describe("GET /api/tables/:id/export", () => {
  it("streams the view's rows with its visible columns in order, as a UTF-8 CSV attachment", async () => {
    const { response, bytes, rows } = await csv("viewId=viw_orders_large");
    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("content-disposition")).toContain("filename*=UTF-8''Orders%20-%20Large%20orders.csv");
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);

    const [header, ...body] = rows;
    expect(header).not.toContain("Notes"); // hidden in this view
    expect(header[0]).toBe("Order #");

    // The same rows, in the same order, as the grid gets.
    const window = await (await rowsRoute.GET(new Request("http://localhost/api/tables/tbl_orders/rows?viewId=viw_orders_large&limit=500"), params)).json();
    expect(body).toHaveLength(window.total);
    expect(response.headers.get("x-total-rows")).toBe(String(window.total));
    expect(body.map((row) => row[0])).toEqual(window.rows.slice(0, body.length).map((row: { values: Record<string, string> }) => row.values.fld_o_number));
  });

  it("applies an unsaved filter from the query and exports every row past one chunk", async () => {
    const all = await csv("");
    expect(all.rows.length - 1).toBe(500); // SEED_SCALE 0.01: 500 orders, more than one 500-row chunk with the header
    const filter = encodeFilterParam({ conjunction: "and", conditions: [{ fieldId: "fld_o_paid", operator: "isChecked" }], groups: [] });
    const paid = await csv(`filter=${filter}`);
    const paidColumn = paid.rows[0].indexOf("Paid");
    expect(paid.rows.slice(1).every((row) => row[paidColumn] === "true")).toBe(true);
  });

  it("guards text that would run as a spreadsheet formula", async () => {
    applyRowBatch({ id: TABLE_IDS.orders, baseId: BASE_ID }, [{ op: "update", rowId: "row_o_000001", values: { fld_o_number: '=cmd|"/c calc"!A1' }, rev: 1 }]);
    const { rows } = await csv("sort=fld_o_number:asc");
    expect(rows.some((row) => row[0] === `'=cmd|"/c calc"!A1`)).toBe(true);
  });

  it("rejects bad parameters like the rows endpoint", async () => {
    expect((await exportOf("filter=garbage")).status).toBe(400);
    expect((await exportOf("viewId=viw_customers_all")).status).toBe(404);
  });
});
