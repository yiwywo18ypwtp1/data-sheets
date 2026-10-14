import { describe, expect, it } from "vitest";
import type { FilterCondition, FilterGroup } from "@/lib/domain/filter";
import type { Row } from "@/lib/domain/row";
import type { Sort } from "@/lib/domain/view";
import { wallTimeAt } from "@/lib/timezone";
import { getDb } from "./db";
import { queryRows } from "./rows";
import { TABLE_IDS } from "./seed";
import { getTable } from "./tables";

const orders = getTable(TABLE_IDS.orders)!;
const context = { now: new Date(process.env.MOCK_NOW!), timeZone: "UTC" };
const ALL = 100_000;

function query(filter: Partial<FilterGroup> = {}, sorts: Sort[] = [], offset = 0, limit = ALL) {
  return queryRows(orders, {
    filter: { conjunction: "and", conditions: [], groups: [], ...filter },
    sorts,
    offset,
    limit,
    context,
  });
}
const where = (...conditions: FilterCondition[]) => query({ conditions });
const allRows = query().rows;

describe("seed", () => {
  it("creates the scaled demo data", () => {
    expect(allRows).toHaveLength(500);
    expect(orders.fields).toHaveLength(30);
    expect(orders.views).toHaveLength(3);
    expect(getTable(TABLE_IDS.customers)!.fields.filter((field) => field.type === "formula")).toHaveLength(1);
  });

  it("materializes lookups and formulas", () => {
    for (const row of allRows.slice(0, 50)) {
      const { values } = row;
      const unitPrice = Number((values.fld_o_unit_price as string[] | undefined)?.[0] ?? 0);
      expect(values.fld_o_subtotal).toBeCloseTo((values.fld_o_qty as number) * unitPrice, 6);
      expect(values.fld_o_total).toBeCloseTo(
        (values.fld_o_subtotal as number) - (values.fld_o_discount as number) + ((values.fld_o_shipping as number) ?? 0),
        6,
      );
    }
  });
});

describe("queryRows filters", () => {
  const ids = (rows: Row[]) => new Set(rows.map((row) => row.id));

  it("checkbox conditions partition the table", () => {
    const paid = where({ fieldId: "fld_o_paid", operator: "isChecked" });
    const unpaid = where({ fieldId: "fld_o_paid", operator: "isNotChecked" });
    expect(paid.total + unpaid.total).toBe(allRows.length);
    expect(paid.rows.every((row) => row.values.fld_o_paid === true)).toBe(true);
  });

  it("text contains is case-insensitive, also for Cyrillic", () => {
    const result = where({ fieldId: "fld_o_notes", operator: "contains", value: "ПОВТОРНЕ" });
    const expected = allRows.filter((row) => String(row.values.fld_o_notes ?? "").includes("Повторне"));
    expect(result.total).toBeGreaterThan(0);
    expect(ids(result.rows)).toEqual(ids(expected));
  });

  it("isEmpty matches missing values", () => {
    const result = where({ fieldId: "fld_o_coupon", operator: "isEmpty" });
    expect(ids(result.rows)).toEqual(ids(allRows.filter((row) => row.values.fld_o_coupon === undefined)));
  });

  it("number comparisons work on formula results; ≠ keeps empty cells", () => {
    const large = where({ fieldId: "fld_o_total", operator: "gt", value: 1000 });
    expect(large.rows.every((row) => (row.values.fld_o_total as number) > 1000)).toBe(true);

    const notFive = where({ fieldId: "fld_o_rating", operator: "neq", value: 5 });
    const expected = allRows.filter((row) => row.values.fld_o_rating !== 5);
    expect(notFive.total).toBe(expected.length);

    const between = where({ fieldId: "fld_o_qty", operator: "between", value: { min: 3, max: 5 } });
    expect(ids(between.rows)).toEqual(ids(allRows.filter((row) => [3, 4, 5].includes(row.values.fld_o_qty as number))));
  });

  it("date-time 'is' uses calendar days in the field's time zone", () => {
    const sample = allRows[7].values.fld_o_ordered_at as string;
    const wall = wallTimeAt(Date.parse(sample), "Europe/Berlin");
    const day = `${wall.year}-${String(wall.month).padStart(2, "0")}-${String(wall.day).padStart(2, "0")}`;

    const result = where({ fieldId: "fld_o_ordered_at", operator: "is", value: day });
    const expected = allRows.filter((row) => {
      const w = wallTimeAt(Date.parse(row.values.fld_o_ordered_at as string), "Europe/Berlin");
      return w.year === wall.year && w.month === wall.month && w.day === wall.day;
    });
    expect(ids(result.rows)).toEqual(ids(expected));
  });

  it("date-only before/after/withinLastDays", () => {
    const before = where({ fieldId: "fld_o_due", operator: "before", value: "2025-06-01" });
    expect(before.rows.every((row) => (row.values.fld_o_due as string) < "2025-06-01")).toBe(true);
    const after = where({ fieldId: "fld_o_due", operator: "after", value: "2025-06-01" });
    expect(after.rows.every((row) => (row.values.fld_o_due as string) > "2025-06-01")).toBe(true);

    // MOCK_NOW is 2026-10-13: the last 30 days are 2026-09-14 … 2026-10-13
    const recent = where({ fieldId: "fld_o_due", operator: "withinLastDays", value: 30 });
    const expected = allRows.filter((row) => {
      const due = row.values.fld_o_due as string;
      return due >= "2026-09-14" && due <= "2026-10-13";
    });
    expect(ids(recent.rows)).toEqual(ids(expected));
  });

  it("select isAnyOf / isNoneOf partition the table, including empty cells", () => {
    const status = ["opt_status_0", "opt_status_4"];
    const any = where({ fieldId: "fld_o_status", operator: "isAnyOf", value: status });
    const none = where({ fieldId: "fld_o_status", operator: "isNoneOf", value: status });
    expect(any.total + none.total).toBe(allRows.length);

    const tagged = where({ fieldId: "fld_o_tags", operator: "isAnyOf", value: ["opt_tags_1"] });
    expect(tagged.rows.every((row) => (row.values.fld_o_tags as string[]).includes("opt_tags_1"))).toBe(true);
    const untagged = where({ fieldId: "fld_o_tags", operator: "isNoneOf", value: ["opt_tags_1"] });
    expect(tagged.total + untagged.total).toBe(allRows.length);
  });

  it("link hasAnyOf and lookup text filters", () => {
    const customerId = (allRows[0].values.fld_o_customer as string[])[0];
    const linked = where({ fieldId: "fld_o_customer", operator: "hasAnyOf", value: [customerId] });
    expect(linked.rows.every((row) => (row.values.fld_o_customer as string[])[0] === customerId)).toBe(true);

    const discount = where({ fieldId: "fld_o_cust_discount", operator: "is", value: "20" });
    expect(discount.rows.every((row) => (row.values.fld_o_cust_discount as string[])[0] === "20")).toBe(true);
  });

  it("combines groups with OR and AND", () => {
    const result = query({
      conjunction: "or",
      conditions: [{ fieldId: "fld_o_rush", operator: "isChecked" }],
      groups: [
        {
          conjunction: "and",
          conditions: [
            { fieldId: "fld_o_gift", operator: "isChecked" },
            { fieldId: "fld_o_qty", operator: "gt", value: 10 },
          ],
        },
      ],
    });
    const expected = allRows.filter(
      (row) => row.values.fld_o_rush === true || (row.values.fld_o_gift === true && (row.values.fld_o_qty as number) > 10),
    );
    expect(ids(result.rows)).toEqual(ids(expected));
  });

  it("skips incomplete conditions and conditions on deleted fields", () => {
    expect(where({ fieldId: "fld_o_qty", operator: "eq", value: null }).total).toBe(allRows.length);
    expect(where({ fieldId: "fld_gone", operator: "isChecked" }).total).toBe(allRows.length);
  });

  it("treats SQL in values as plain text", () => {
    const result = where({ fieldId: "fld_o_notes", operator: "contains", value: "'); DROP TABLE rows; --" });
    expect(result.total).toBe(0);
    expect(getDb().prepare("SELECT count(*) AS n FROM rows").get()).toEqual({ n: 555 });
  });
});

describe("queryRows sorting, paging and aggregates", () => {
  it("sorts numbers with empty values last in both directions", () => {
    for (const direction of ["asc", "desc"] as const) {
      const ratings = query({}, [{ fieldId: "fld_o_rating", direction }]).rows.map((row) => row.values.fld_o_rating ?? null);
      const firstEmpty = ratings.indexOf(null);
      expect(ratings.slice(firstEmpty).every((rating) => rating === null)).toBe(true);
      const present = ratings.slice(0, firstEmpty) as number[];
      expect(present).toEqual([...present].sort((a, b) => (direction === "asc" ? a - b : b - a)));
    }
  });

  it("sorts selects by option order", () => {
    const statuses = query({}, [{ fieldId: "fld_o_status", direction: "asc" }]).rows.map((row) => row.values.fld_o_status as string);
    const indexes = statuses.map((id) => Number(id.split("_").pop()));
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
  });

  it("pages are stable: consecutive windows add up to the full sorted list", () => {
    const sorts: Sort[] = [{ fieldId: "fld_o_status", direction: "desc" }];
    const full = query({}, sorts).rows.map((row) => row.id);
    const paged = [0, 1, 2, 3, 4].flatMap((page) => query({}, sorts, page * 100, 100).rows.map((row) => row.id));
    expect(paged).toEqual(full);
  });

  it("returns total and aggregates for the whole filtered set, not just the window", () => {
    const filter = { conditions: [{ fieldId: "fld_o_paid", operator: "isChecked" } as FilterCondition] };
    const window = query(filter, [], 0, 10);
    const all = query(filter).rows;
    expect(window.rows).toHaveLength(10);
    expect(window.total).toBe(all.length);
    const qtySum = all.reduce((sum, row) => sum + (row.values.fld_o_qty as number), 0);
    expect(window.aggregates.fld_o_qty.sum).toBe(qtySum);
    expect(window.aggregates.fld_o_qty.avg).toBeCloseTo(qtySum / all.length, 9);
    expect(window.aggregates.fld_o_total).toBeDefined();
    expect(window.aggregates.fld_o_notes).toBeUndefined();
  });
});
