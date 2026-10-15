import { afterEach, describe, expect, it } from "vitest";
import { getDb } from "./db";
import { createField } from "./fields";
import { getRowsByIds, queryRows } from "./rows";
import { refreshClockFormulas } from "./rowWrites";
import { TABLE_IDS } from "./seed";
import { getTable } from "./tables";

const MOCK_NOW = process.env.MOCK_NOW;
afterEach(() => {
  process.env.MOCK_NOW = MOCK_NOW;
});

describe("refreshClockFormulas", () => {
  it("recomputes TODAY() formulas (and formulas on top of them) on the first read of a new day, without a new revision", () => {
    const days = createField(TABLE_IDS.orders, { name: "Days to due", type: "formula", expression: 'DATETIME_DIFF({Due date}, TODAY(), "days")', resultType: "number" });
    const late = createField(TABLE_IDS.orders, { name: "Late", type: "formula", expression: "{Days to due} < 0", resultType: "checkbox" });
    const plain = createField(TABLE_IDS.orders, { name: "Qty x2", type: "formula", expression: "{Qty} * 2", resultType: "number" });
    refreshClockFormulas(TABLE_IDS.orders);

    const row = getDb().prepare("SELECT id FROM rows WHERE table_id = ? AND json_extract(cells, '$.fld_o_due') IS NOT NULL LIMIT 1").get(TABLE_IDS.orders) as { id: string };
    const [before] = getRowsByIds(TABLE_IDS.orders, [row.id]);
    const due = Date.parse(before.values.fld_o_due as string);
    expect(before.values[days.id]).toBe(Math.trunc((due - Date.parse("2026-10-13")) / 86_400_000));

    process.env.MOCK_NOW = "2026-10-14T00:00:10.000Z";
    refreshClockFormulas(TABLE_IDS.orders);
    const [after] = getRowsByIds(TABLE_IDS.orders, [row.id]);
    expect(after.values[days.id]).toBe((before.values[days.id] as number) - 1);
    expect(after.values[plain.id]).toBe(before.values[plain.id]);
    expect(after.rev).toBe(before.rev);
    expect(after.updatedAt).toBe(before.updatedAt);

    // The stored values are what filters read: a filter on the formula follows the day too.
    const table = getTable(TABLE_IDS.orders)!;
    const count = (value: number) =>
      queryRows(table, {
        filter: { conjunction: "and", conditions: [{ fieldId: days.id, operator: "eq", value }], groups: [] },
        sorts: [],
        offset: 0,
        limit: 1,
        context: { now: new Date(process.env.MOCK_NOW!), timeZone: "UTC" },
      }).total;
    expect(count(after.values[days.id] as number)).toBeGreaterThan(0);
    // The row itself no longer matches yesterday's value.
    const yesterdayIds = queryRows(table, {
      filter: { conjunction: "and", conditions: [{ fieldId: days.id, operator: "eq", value: before.values[days.id] as number }], groups: [] },
      sorts: [],
      offset: 0,
      limit: 1000,
      context: { now: new Date(process.env.MOCK_NOW!), timeZone: "UTC" },
    }).rows.map((candidate) => candidate.id);
    expect(yesterdayIds).not.toContain(row.id);
    expect(typeof after.values[late.id]).toBe("boolean");
  });

  it("does nothing more the same day", () => {
    process.env.MOCK_NOW = "2026-10-20T08:00:00.000Z";
    refreshClockFormulas(TABLE_IDS.orders);
    const changes = () => (getDb().prepare("SELECT total_changes() AS n").get() as { n: number }).n;
    const before = changes();
    refreshClockFormulas(TABLE_IDS.orders);
    expect(changes()).toBe(before);
  });
});
