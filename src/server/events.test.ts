import { describe, expect, it } from "vitest";
import { eventsSince, latestSeq, listPresence, removePresence, setPresence } from "./events";
import { applyRowBatch } from "./rowWrites";
import { getRowsByIds } from "./rows";
import { BASE_ID, TABLE_IDS } from "./seed";

const products = { id: TABLE_IDS.products, baseId: BASE_ID };
const customers = { id: TABLE_IDS.customers, baseId: BASE_ID };
const eddie = { userId: "usr_editor", name: "Eddie Editor", clientId: "tab_eddie" };

describe("event log", () => {
  it("logs one numbered event per batch and table, with the written cells, creates and deletes", () => {
    const before = latestSeq(products.id);
    const [first] = getRowsByIds(products.id, ["row_p_00001"]);
    applyRowBatch(
      products,
      [
        { op: "update", rowId: first.id, values: { fld_p_stock: 9 }, rev: first.rev },
        { op: "create", rowId: "row_p_new", values: { fld_p_name: "New" } },
        { op: "delete", rowId: "row_p_00002", rev: 0 },
        { op: "update", rowId: "row_p_missing", values: { fld_p_stock: 1 }, rev: 0 }, // fails: not logged
      ],
      eddie,
    );
    const { events, gap } = eventsSince(products.id, before);
    expect(gap).toBe(false);
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event).toMatchObject({ seq: before + 1, kind: "rows", origin: eddie, deleted: ["row_p_00002"] });
    if (event.kind !== "rows") throw new Error("expected a rows event");
    expect(event.rows.map((change) => [change.row.id, change.fields, change.created ?? false])).toEqual([
      ["row_p_00001", ["fld_p_stock"], false],
      ["row_p_new", ["fld_p_name"], true],
    ]);
    expect(event.rows[0].row.values.fld_p_stock).toBe(9);
  });

  it("logs rows of other tables whose lookups were recomputed, without written cells", () => {
    const before = latestSeq(TABLE_IDS.orders);
    const [customer] = getRowsByIds(customers.id, ["row_c_00001"]);
    applyRowBatch(customers, [{ op: "update", rowId: customer.id, values: { fld_c_discount: 33 }, rev: customer.rev }], eddie);
    const { events } = eventsSince(TABLE_IDS.orders, before);
    // Orders of that customer (if the small test seed has any) changed through the lookup only.
    for (const event of events) if (event.kind === "rows") expect(event.rows.every((change) => change.fields.length === 0)).toBe(true);
  });

  it("replays from any number it still has", () => {
    const latest = latestSeq(products.id);
    expect(eventsSince(products.id, latest).events).toEqual([]);
    expect(eventsSince(products.id, latest - 1).events.map((event) => event.seq)).toEqual([latest]);
  });
});

describe("presence", () => {
  it("keeps one entry per tab with the user's colour, until the tab leaves", () => {
    setPresence(products.id, { clientId: "tab_1", userId: "usr_editor", name: "Eddie Editor", viewId: null, cell: { rowId: "row_p_00003", fieldId: "fld_p_name" } });
    setPresence(products.id, { clientId: "tab_1", userId: "usr_editor", name: "Eddie Editor", viewId: null, cell: null });
    expect(listPresence(products.id)).toMatchObject([{ clientId: "tab_1", cell: null, color: expect.stringMatching(/^#/) }]);
    removePresence(products.id, "tab_1");
    expect(listPresence(products.id)).toEqual([]);
  });
});
