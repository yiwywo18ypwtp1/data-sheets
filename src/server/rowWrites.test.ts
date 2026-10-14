import { describe, expect, it } from "vitest";
import type { Field } from "@/lib/domain/field";
import type { Row, RowOpResult } from "@/lib/domain/row";
import { computeFields, FormulaCache } from "./compute";
import { applyRowBatch } from "./rowWrites";
import { getRowsByIds, queryRows } from "./rows";
import { BASE_ID, TABLE_IDS } from "./seed";
import { getTable } from "./tables";

const orders = { id: TABLE_IDS.orders, baseId: BASE_ID };
const customers = { id: TABLE_IDS.customers, baseId: BASE_ID };
const products = { id: TABLE_IDS.products, baseId: BASE_ID };
const context = { now: new Date(process.env.MOCK_NOW!), timeZone: "UTC" };

const getRow = (tableId: string, id: string) => getRowsByIds(tableId, [id])[0];
const okRow = (result: RowOpResult): Row => {
  if (!result.ok) throw new Error(`Expected success, got ${JSON.stringify(result.error)}`);
  return result.row!;
};

function ordersWhere(fieldId: string, value: string) {
  const table = getTable(TABLE_IDS.orders)!;
  return queryRows(table, {
    filter: { conjunction: "and", conditions: [{ fieldId, operator: "is", value }], groups: [] },
    sorts: [],
    offset: 0,
    limit: 1000,
    context,
  });
}

describe("applyRowBatch", () => {
  it("recomputes formulas that depend on the edited cell and bumps rev", () => {
    const before = getRow(TABLE_IDS.orders, "row_o_000001");
    const neighbour = getRow(TABLE_IDS.orders, "row_o_000002");
    const unitPrice = Number((before.values.fld_o_unit_price as string[])[0]);

    const [result] = applyRowBatch(orders, [{ op: "update", rowId: before.id, values: { fld_o_qty: 7 }, rev: before.rev }]);
    const row = okRow(result);

    expect(row.rev).toBe(before.rev + 1);
    expect(row.values.fld_o_qty).toBe(7);
    expect(row.values.fld_o_subtotal).toBeCloseTo(7 * unitPrice, 6);
    expect(row.values.fld_o_total).toBeCloseTo(
      (row.values.fld_o_subtotal as number) - (row.values.fld_o_discount as number) + ((row.values.fld_o_shipping as number) ?? 0),
      6,
    );
    // untouched cells and rows stay as they were
    expect(row.values.fld_o_notes).toEqual(before.values.fld_o_notes);
    expect(getRow(TABLE_IDS.orders, neighbour.id)).toEqual(neighbour);
  });

  it("propagates a change in a linked table through lookups and formulas, and filters see it", () => {
    const order = getRow(TABLE_IDS.orders, "row_o_000003");
    const customerId = (order.values.fld_o_customer as string[])[0];
    expect(ordersWhere("fld_o_cust_discount", "33").total).toBe(0);

    okRow(applyRowBatch(customers, [{ op: "update", rowId: customerId, values: { fld_c_discount: 33 }, rev: 1 }])[0]);

    const updated = getRow(TABLE_IDS.orders, order.id);
    expect(updated.values.fld_o_cust_discount).toEqual(["33"]);
    expect(updated.values.fld_o_discount).toBeCloseTo(
      Math.round((updated.values.fld_o_subtotal as number) * 33) / 100,
      2,
    );
    expect(updated.rev).toBe(order.rev + 1);
    // the cached query result was invalidated by the write
    const filtered = ordersWhere("fld_o_cust_discount", "33");
    expect(filtered.rows.map((row) => row.id)).toContain(order.id);
    expect(filtered.rows.every((row) => (row.values.fld_o_customer as string[])[0] === customerId)).toBe(true);
  });

  it("returns a partial result: invalid ops fail with field errors, valid ones are applied", () => {
    const results = applyRowBatch(orders, [
      { op: "update", rowId: "row_o_000010", values: { fld_o_qty: 2.5 }, rev: 1 },
      { op: "update", rowId: "row_o_000011", values: { fld_o_qty: 4 }, rev: 1 },
      { op: "update", rowId: "row_o_000012", values: { fld_o_total: 1 }, rev: 1 },
      { op: "update", rowId: "row_o_000013", values: { fld_nope: 1 }, rev: 1 },
      { op: "update", rowId: "row_o_000014", values: { fld_o_customer: ["row_c_99999"] }, rev: 1 },
      { op: "update", rowId: "row_missing", values: { fld_o_qty: 1 }, rev: 1 },
    ]);

    expect(results.map((result) => result.ok)).toEqual([false, true, false, false, false, false]);
    const errors = results.map((result) => (result.ok ? null : result.error));
    expect(errors[0]?.fieldErrors?.fld_o_qty).toBe("At most 0 decimal places");
    expect(errors[2]?.fieldErrors?.fld_o_total).toBe("Computed field cannot be edited");
    expect(errors[3]?.fieldErrors?.fld_nope).toBe("Field does not exist");
    expect(errors[4]?.fieldErrors?.fld_o_customer).toBe("Linked record does not exist");
    expect(errors[5]?.code).toBe("NOT_FOUND");
    expect(getRow(TABLE_IDS.orders, "row_o_000011").values.fld_o_qty).toBe(4);
    expect(getRow(TABLE_IDS.orders, "row_o_000010").values.fld_o_qty).not.toBe(2.5);
  });

  it("creates rows with client ids and computed values; duplicate ids conflict", () => {
    const productId = "row_p_00001";
    const price = getRow(TABLE_IDS.products, productId).values.fld_p_price as number;
    const [created, duplicate] = applyRowBatch(orders, [
      { op: "create", rowId: "row_new_1", values: { fld_o_number: "ORD-NEW", fld_o_product: [productId], fld_o_qty: 2 } },
      { op: "create", rowId: "row_o_000001", values: {} },
    ]);

    const row = okRow(created);
    expect(row.values.fld_o_unit_price).toEqual([String(price)]);
    expect(row.values.fld_o_subtotal).toBeCloseTo(2 * price, 6);
    expect(row.rev).toBe(1);
    expect(duplicate).toMatchObject({ ok: false, error: { code: "CONFLICT" } });

    const all = queryRows(getTable(TABLE_IDS.orders)!, {
      filter: { conjunction: "and", conditions: [], groups: [] },
      sorts: [],
      offset: 0,
      limit: 1000,
      context,
    });
    expect(all.rows.at(-1)?.id).toBe("row_new_1"); // new rows go last in the default order
  });

  it("deleting a record removes it from links and updates lookups", () => {
    const productId = "row_p_00002";
    const before = queryRows(getTable(TABLE_IDS.orders)!, {
      filter: { conjunction: "and", conditions: [{ fieldId: "fld_o_product", operator: "hasAnyOf", value: [productId] }], groups: [] },
      sorts: [],
      offset: 0,
      limit: 1000,
      context,
    }).rows;
    expect(before.length).toBeGreaterThan(0);

    const [result, missing] = applyRowBatch(products, [
      { op: "delete", rowId: productId, rev: 1 },
      { op: "delete", rowId: "row_missing", rev: 1 },
    ]);
    expect(result).toEqual({ ok: true, rowId: productId, row: null });
    expect(missing).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });

    for (const order of before) {
      const after = getRow(TABLE_IDS.orders, order.id);
      expect(after.values.fld_o_product).toBeUndefined();
      expect(after.values.fld_o_unit_price).toBeUndefined();
      expect(after.values.fld_o_subtotal).toBe(0);
    }
  });
});

describe("computeFields", () => {
  it("stores formula errors separately and leaves the value empty", () => {
    const fields: Field[] = [
      { id: "a", name: "A", type: "number", precision: 0 },
      { id: "ratio", name: "Ratio", type: "formula", expression: "{a} / 0", resultType: "number" },
      { id: "broken", name: "Broken", type: "formula", expression: "{deleted} + 1", resultType: "number" },
    ];
    const byId = new Map(fields.map((field) => [field.id, field]));
    const result = computeFields(["ratio", "broken"], { values: { a: 1, ratio: 5 }, errors: {} }, byId, new FormulaCache(byId), () => [], context);
    expect(result.values.ratio).toBeNull();
    expect(result.errors).toEqual({ ratio: "#DIV/0! Division by zero", broken: '#REF! Unknown field "deleted"' });
  });
});

describe("restoring deleted rows", () => {
  it("brings a record back with its id, values and place in creation order", () => {
    const table = getTable(TABLE_IDS.products)!;
    const unsorted = () => queryRows(table, { filter: { conjunction: "and", conditions: [], groups: [] }, sorts: [], offset: 0, limit: 10, context }).rows.map((row) => row.id);
    const before = unsorted();
    const [victim, next] = getRowsByIds(TABLE_IDS.products, [before[2], before[3]]);
    applyRowBatch(products, [
      { op: "delete", rowId: victim.id, rev: victim.rev },
      { op: "delete", rowId: next.id, rev: next.rev },
    ]);
    const results = applyRowBatch(products, [
      { op: "create", rowId: next.id, values: { fld_p_name: next.values.fld_p_name as string }, createdAt: next.createdAt },
      { op: "create", rowId: victim.id, values: { fld_p_name: victim.values.fld_p_name as string }, createdAt: victim.createdAt },
    ]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(unsorted()).toEqual(before);
    expect(getRow(TABLE_IDS.products, victim.id).createdAt).toBe(victim.createdAt);
  });
});
