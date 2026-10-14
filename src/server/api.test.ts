import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as tableRoute from "@/app/api/tables/[id]/route";
import * as rowsRoute from "@/app/api/tables/[id]/rows/route";
import * as batchRoute from "@/app/api/tables/[id]/rows/batch/route";
import * as fieldsRoute from "@/app/api/tables/[id]/fields/route";
import * as fieldRoute from "@/app/api/tables/[id]/fields/[fieldId]/route";
import * as searchRoute from "@/app/api/tables/[id]/records/search/route";
import * as viewRoute from "@/app/api/views/[id]/route";
import * as formulaRoute from "@/app/api/formula/check/route";
import * as importRoute from "@/app/api/tables/[id]/import/route";
import { encodeFilterParam } from "@/lib/domain/query";
import type { Row } from "@/lib/domain/row";
import type { TableMeta } from "@/lib/domain/table";
import { getRowsByIds } from "./rows";
import { getTable, getView } from "./tables";

// Mock auth: the current user comes from the `ds_user` cookie.
let userId = "usr_creator";
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === "ds_user" ? { value: userId } : undefined) }),
}));
beforeEach(() => {
  userId = "usr_creator";
});

const BASE = "http://localhost";
const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });
const get = (path: string, headers: Record<string, string> = {}) => new Request(`${BASE}${path}`, { headers });
const send = (method: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${BASE}${path}`, { method, body: typeof body === "string" ? body : JSON.stringify(body), headers });

async function rows(query: string) {
  return rowsRoute.GET(get(`/api/tables/tbl_orders/rows?${query}`), params({ id: "tbl_orders" }));
}

describe("GET /api/tables/:id", () => {
  it("returns the schema with an ETag and answers 304 to a matching If-None-Match", async () => {
    const response = await tableRoute.GET(get("/api/tables/tbl_orders"), params({ id: "tbl_orders" }));
    expect(response.status).toBe(200);
    const { table } = (await response.json()) as { table: TableMeta };
    expect(table.fields).toHaveLength(30);
    const tag = response.headers.get("ETag")!;

    const cached = await tableRoute.GET(get("/api/tables/tbl_orders", { "If-None-Match": tag }), params({ id: "tbl_orders" }));
    expect(cached.status).toBe(304);
  });

  it("uses the unified error format", async () => {
    const response = await tableRoute.GET(get("/api/tables/nope"), params({ id: "nope" }));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: "NOT_FOUND", message: "Table not found" } });
  });
});

describe("GET /api/tables/:id/rows", () => {
  it.each([
    ["offset=-1", "offset"],
    ["limit=100000", "limit"],
    ["limit=0", "limit"],
    ["offset=abc", "offset"],
    ["filter=garbage", "filter"],
    ["sort=fld_o_qty:sideways", "sort"],
    ["tz=Mars/Base", "tz"],
    ["viewId=bad id", "viewId"],
  ])("rejects %s with a 400 naming the parameter", async (query, param) => {
    const response = await rows(query);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string; fieldErrors: Record<string, string> } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(Object.keys(body.error.fieldErrors)).toContain(param);
  });

  it("rejects a filter whose operator doesn't fit the field", async () => {
    const filter = encodeFilterParam({ conjunction: "and", conditions: [{ fieldId: "fld_o_notes", operator: "gt", value: 1 }], groups: [] });
    expect((await rows(`filter=${filter}`)).status).toBe(400);
  });

  it("answers 404 for a view of another table", async () => {
    const response = await rows("viewId=viw_customers_vip");
    expect(response.status).toBe(404);
  });

  it("applies the view's filter and sorts, and returns labels for linked records", async () => {
    const response = await rows("viewId=viw_orders_unpaid&limit=50");
    const body = (await response.json()) as { rows: Row[]; total: number; linkedLabels: Record<string, string> };
    expect(body.rows).toHaveLength(50);
    expect(body.rows.every((row) => row.values.fld_o_paid !== true)).toBe(true);
    const dates = body.rows.map((row) => row.values.fld_o_ordered_at as string);
    expect(dates).toEqual([...dates].sort().reverse());
    const customerId = (body.rows[0].values.fld_o_customer as string[])[0];
    expect(body.linkedLabels[customerId]).toEqual(getRowsByIds("tbl_customers", [customerId])[0].values.fld_c_name);
  });

  it("lets filter and sort params override the view", async () => {
    const filter = encodeFilterParam({ conjunction: "and", conditions: [{ fieldId: "fld_o_qty", operator: "eq", value: 3 }], groups: [] });
    const body = (await (await rows(`viewId=viw_orders_unpaid&filter=${filter}&sort=fld_o_number:desc&limit=500`)).json()) as { rows: Row[] };
    expect(body.rows.every((row) => row.values.fld_o_qty === 3)).toBe(true);
    const numbers = body.rows.map((row) => row.values.fld_o_number as string);
    expect(numbers).toEqual([...numbers].sort().reverse());
  });
});

describe("POST /api/tables/:id/rows/batch", () => {
  const batch = (body: unknown) => batchRoute.POST(send("POST", "/api/tables/tbl_orders/rows/batch", body), params({ id: "tbl_orders" }));

  it("forbids viewers on the server, whatever the UI shows", async () => {
    userId = "usr_viewer";
    const response = await batch({ ops: [{ op: "update", rowId: "row_o_000001", values: { fld_o_qty: 1 }, rev: 1 }] });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("FORBIDDEN");
  });

  it("returns per-op results for editors", async () => {
    userId = "usr_editor";
    const response = await batch({
      ops: [
        { op: "update", rowId: "row_o_000001", values: { fld_o_qty: 9 }, rev: 1 },
        { op: "update", rowId: "row_o_000002", values: { fld_o_qty: "nine" }, rev: 1 },
      ],
    });
    expect(response.status).toBe(200);
    const { results } = (await response.json()) as { results: { ok: boolean }[] };
    expect(results.map((result) => result.ok)).toEqual([true, false]);
  });

  it("rejects malformed bodies and more than 1000 ops", async () => {
    expect((await batch("{not json")).status).toBe(400);
    const ops = Array.from({ length: 1001 }, () => ({ op: "delete", rowId: "row_x", rev: 1 }));
    expect((await batch({ ops })).status).toBe(400);
  });
});

describe("fields", () => {
  const createField = (body: unknown) => fieldsRoute.POST(send("POST", "/api/tables/tbl_orders/fields", body), params({ id: "tbl_orders" }));
  const patchField = (fieldId: string, body: unknown, query = "") =>
    fieldRoute.PATCH(send("PATCH", `/api/tables/tbl_orders/fields/${fieldId}${query}`, body), params({ id: "tbl_orders", fieldId }));
  const deleteField = (fieldId: string, query = "") =>
    fieldRoute.DELETE(new Request(`${BASE}/api/tables/tbl_orders/fields/${fieldId}${query}`, { method: "DELETE" }), params({ id: "tbl_orders", fieldId }));

  it("creates a formula typed with names, stores ids, infers the type and computes every row", async () => {
    const response = await createField({ name: "Double qty", type: "formula", expression: "{Qty} * 2", resultType: "text" });
    expect(response.status).toBe(201);
    const { field } = (await response.json()) as { field: { id: string; expression: string; resultType: string } };
    expect(field.expression).toBe("{fld_o_qty} * 2");
    expect(field.resultType).toBe("number");
    const [row] = getRowsByIds("tbl_orders", ["row_o_000005"]);
    expect(row.values[field.id]).toBe((row.values.fld_o_qty as number) * 2);
  });

  it("reports an unknown field with its position", async () => {
    const response = await createField({ name: "Bad", type: "formula", expression: "{Qty} * {Prise}", resultType: "number" });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { fieldErrors: Record<string, string>; details: { position: number } } };
    expect(body.error.fieldErrors.expression).toBe('Unknown field "Prise" at 8');
    expect(body.error.details.position).toBe(8);
  });

  it("rejects duplicate names and a cycle, showing the path", async () => {
    expect((await createField({ name: "qty", type: "checkbox" })).status).toBe(400);

    const response = await patchField("fld_o_subtotal", { expression: "{Total} * 2" });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toBe("Circular reference: Subtotal → Total → Subtotal");
  });

  it("only lets creators change the schema", async () => {
    userId = "usr_editor";
    expect((await createField({ name: "X", type: "checkbox" })).status).toBe(403);
  });

  it("renames a field without breaking formulas that use it", async () => {
    const response = await patchField("fld_o_qty", { name: "Quantity" });
    expect(response.status).toBe(200);
    const check = await formulaRoute.POST(send("POST", "/api/formula/check", { tableId: "tbl_orders", expression: "{Quantity} + 1" }), {});
    expect(await check.json()).toMatchObject({ ok: true, resultType: "number", dependencies: [{ id: "fld_o_qty", name: "Quantity" }] });
    expect(getTable("tbl_orders")!.fields.find((field) => field.id === "fld_o_subtotal")).toMatchObject({
      expression: "{fld_o_qty} * {fld_o_unit_price}",
    });
  });

  it("previews and converts text → number (values that aren't numbers become empty), and back", async () => {
    const rowIds = ["row_o_000001", "row_o_000002", "row_o_000003"];
    const writes = await batchRoute.POST(
      send("POST", "/api/tables/tbl_orders/rows/batch", { ops: rowIds.map((rowId, i) => ({ op: "update", rowId, values: { fld_o_rep: ["1 234,5", "42", "n/a"][i] }, rev: 0 })) }),
      params({ id: "tbl_orders" }),
    );
    expect(writes.status).toBe(200);
    const asNumber = { name: "Sales rep", type: "number", precision: 1 };

    const preview = await patchField("fld_o_rep", asNumber, "?preview=1&locale=uk-UA&tz=Europe/Kyiv");
    expect(preview.status).toBe(200);
    const { preview: summary } = (await preview.json()) as { preview: { total: number; converted: number; emptied: number; failures: { from: string }[] } };
    expect(summary.converted + summary.emptied).toBe(summary.total);
    expect(summary.failures.map((failure) => failure.from)).toContain("n/a");
    expect(getTable("tbl_orders")!.fields.find((field) => field.id === "fld_o_rep")!.type).toBe("text"); // nothing changed yet

    expect((await patchField("fld_o_rep", asNumber, "?locale=uk-UA&tz=Europe/Kyiv")).status).toBe(200);
    expect(getRowsByIds("tbl_orders", rowIds).map((row) => row.values.fld_o_rep ?? null)).toEqual([1234.5, 42, null]);

    expect((await patchField("fld_o_rep", { name: "Sales rep", type: "text" })).status).toBe(200);
    expect(getRowsByIds("tbl_orders", rowIds).map((row) => row.values.fld_o_rep ?? null)).toEqual(["1234.5", "42", null]);
  });

  it("converts date ↔ date-time and refuses to change a link's table", async () => {
    const [before] = getRowsByIds("tbl_orders", ["row_o_000004"]);
    expect((await patchField("fld_o_due", { includeTime: true, timeZone: "Europe/Kyiv" })).status).toBe(200);
    const [after] = getRowsByIds("tbl_orders", ["row_o_000004"]);
    expect(after.values.fld_o_due).toMatch(/T\d{2}:00:00\.000Z$/);
    expect((await patchField("fld_o_due", { includeTime: false })).status).toBe(200);
    expect(getRowsByIds("tbl_orders", ["row_o_000004"])[0].values.fld_o_due).toBe(before.values.fld_o_due);
    expect((await patchField("fld_o_customer", { targetTableId: "tbl_products" })).status).toBe(400);
  });

  it("refuses to delete a field that formulas use unless forced, then shows #REF! instead of failing", async () => {
    const blocked = await deleteField("fld_o_shipping");
    expect(blocked.status).toBe(409);
    const body = (await blocked.json()) as { error: { details: { dependents: { name: string }[] } } };
    expect(body.error.details.dependents.map((dependent) => dependent.name)).toEqual(["Total"]);

    expect((await deleteField("fld_o_shipping", "?force=1")).status).toBe(204);
    const [row] = getRowsByIds("tbl_orders", ["row_o_000007"]);
    expect(row.values.fld_o_shipping).toBeUndefined();
    expect(row.values.fld_o_total).toBeUndefined();
    expect(row.errors?.fld_o_total).toMatch(/^#REF!/);
    expect(getView("viw_orders_all")!.view.fieldOrder).not.toContain("fld_o_shipping");
  });

  it("refuses to delete the primary field", async () => {
    expect((await deleteField("fld_o_number", "?force=1")).status).toBe(400);
  });

  it("keeps field ids unique across the whole base", async () => {
    expect((await createField({ id: "fld_c_name", name: "Borrowed id", type: "text" })).status).toBe(409);
  });

  it("keeps the first record when a link stops allowing several", async () => {
    const created = await createField({ name: "Extras", type: "link", targetTableId: "tbl_products", multiple: true });
    const { field } = (await created.json()) as { field: { id: string } };
    await batchRoute.POST(
      send("POST", "/api/tables/tbl_orders/rows/batch", { ops: [{ op: "update", rowId: "row_o_000006", values: { [field.id]: ["row_p_00003", "row_p_00004"] }, rev: 0 }] }),
      params({ id: "tbl_orders" }),
    );
    expect((await patchField(field.id, { multiple: false })).status).toBe(200);
    expect(getRowsByIds("tbl_orders", ["row_o_000006"])[0].values[field.id]).toEqual(["row_p_00003"]);
  });

  it("doesn't let a lookup broken by a force-deleted link block later schema changes", async () => {
    expect((await deleteField("fld_o_product", "?force=1")).status).toBe(204);
    expect((await createField({ name: "After the link", type: "text" })).status).toBe(201);
    expect((await patchField("fld_o_unit_price", { name: "Old unit price" })).status).toBe(200);
    expect((await patchField("fld_o_total", { name: "Grand total" })).status).toBe(200); // reads the deleted Shipping
    // A new problem is still reported, with the field it belongs to.
    const duplicate = await patchField("fld_o_number", { name: "after the link" });
    expect(duplicate.status).toBe(400);
    expect(await duplicate.json()).toMatchObject({ error: { fieldErrors: { name: "A field with this name already exists" } } });
  });
});

describe("PUT /api/views/:id", () => {
  const put = (body: unknown, headers: Record<string, string> = {}) =>
    viewRoute.PUT(send("PUT", "/api/views/viw_customers_vip", body, headers), params({ id: "viw_customers_vip" }));

  it("requires If-Match and rejects a stale version with the current view", async () => {
    const { view, version } = getView("viw_customers_vip")!;
    expect((await put(view)).status).toBe(428);

    const stale = await put(view, { "If-Match": `"${version - 1}"` });
    expect(stale.status).toBe(412);
    expect(((await stale.json()) as { error: { details: { version: number } } }).error.details.version).toBe(version);
  });

  it("saves a valid view, bumping the view and table versions", async () => {
    const { view, version } = getView("viw_customers_vip")!;
    const tableVersion = getTable("tbl_customers")!.version;
    const response = await put({ ...view, sorts: [{ fieldId: "fld_c_name", direction: "asc" }] }, { "If-Match": `"${version}"` });
    expect(response.status).toBe(200);
    expect(response.headers.get("ETag")).toBe(`"${version + 1}"`);
    expect(getView("viw_customers_vip")!.view.sorts).toEqual([{ fieldId: "fld_c_name", direction: "asc" }]);
    expect(getTable("tbl_customers")!.version).toBe(tableVersion + 1);
  });

  it("rejects filters that don't fit the fields", async () => {
    const { view, version } = getView("viw_customers_vip")!;
    const invalid = { ...view, filter: { conjunction: "and", conditions: [{ fieldId: "fld_c_vip", operator: "contains", value: "x" }], groups: [] } };
    expect((await put(invalid, { "If-Match": `"${version}"` })).status).toBe(400);
  });
});

describe("POST /api/formula/check", () => {
  const check = async (body: unknown) => (await formulaRoute.POST(send("POST", "/api/formula/check", body), {})).json();

  it("returns an error with its position", async () => {
    expect(await check({ tableId: "tbl_orders", expression: "SUM({Qty}, " })).toEqual({
      ok: false,
      error: { message: "Unexpected end of formula at 11", position: 11 },
    });
  });

  it("detects a cycle when editing an existing field", async () => {
    expect(await check({ tableId: "tbl_orders", fieldId: "fld_o_subtotal", expression: "{Discount} + 1" })).toMatchObject({
      ok: false,
      error: { message: "Circular reference: Subtotal → Discount → Subtotal" },
    });
  });
});

describe("GET /api/tables/:id/records/search", () => {
  it("finds records by primary value, case-insensitively", async () => {
    const name = getRowsByIds("tbl_products", ["row_p_00003"])[0].values.fld_p_name as string;
    const q = encodeURIComponent(name.toUpperCase());
    const response = await searchRoute.GET(get(`/api/tables/tbl_products/records/search?q=${q}`), params({ id: "tbl_products" }));
    const { records } = (await response.json()) as { records: { id: string; label: string }[] };
    expect(records).toContainEqual({ id: "row_p_00003", label: name });
  });
});

describe("POST /api/tables/:id/import", () => {
  const post = (body: unknown, key?: string) =>
    importRoute.POST(send("POST", "/api/tables/tbl_products/import", body, key ? { "idempotency-key": key } : {}), params({ id: "tbl_products" }));
  const count = () => (rowsRoute.GET(get("/api/tables/tbl_products/rows?limit=1"), params({ id: "tbl_products" })) as Promise<Response>).then(async (response) => ((await response.json()) as { total: number }).total);

  it("imports a batch once per Idempotency-Key and reports rejected rows", async () => {
    const before = await count();
    const body = { rows: [{ fld_p_name: "Imported lamp", fld_p_stock: 3 }, { fld_p_name: "Bad stock", fld_p_stock: "many" }, { fld_p_name: "Imported desk" }] };
    const first = await post(body, "imp_test:0");
    expect(first.status).toBe(200);
    const result = await first.json();
    expect(result).toMatchObject({ imported: 2, failed: [{ index: 1 }] });
    // A retry of the same batch (lost response, double click) doesn't import it again.
    expect(await (await post(body, "imp_test:0")).json()).toEqual(result);
    expect(await count()).toBe(before + 2);
  });

  it("requires the key and a creator", async () => {
    expect((await post({ rows: [{ fld_p_name: "x" }] })).status).toBe(400);
    userId = "usr_editor";
    expect((await post({ rows: [{ fld_p_name: "x" }] }, "imp_test:1")).status).toBe(403);
  });
});

describe("mock network", () => {
  afterEach(() => {
    delete process.env.MOCK_FAILURE_RATE;
  });

  it("fails requests with MOCK_FAILURE_RATE=1", async () => {
    process.env.MOCK_FAILURE_RATE = "1";
    const response = await rows("limit=1");
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("MOCK_FAILURE");
  });
});
