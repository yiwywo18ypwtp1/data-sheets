import { beforeEach, describe, expect, it, vi } from "vitest";
import * as kanbanRoute from "@/app/api/tables/[id]/kanban/route";
import * as viewRoute from "@/app/api/views/[id]/route";
import * as viewsRoute from "@/app/api/tables/[id]/views/route";
import type { KanbanResponse } from "@/lib/domain/api";
import { encodeFilterParam } from "@/lib/domain/query";
import type { View } from "@/lib/domain/view";
import { deleteField, updateField } from "./fields";
import { TABLE_IDS } from "./seed";
import { getTable, getView } from "./tables";
import { createView } from "./views";

let userId = "usr_editor";
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === "ds_user" ? { value: userId } : undefined) }),
}));
beforeEach(() => {
  userId = "usr_editor";
});

const orders = TABLE_IDS.orders;
async function board(query: string): Promise<{ status: number; body: KanbanResponse }> {
  const response = await kanbanRoute.GET(new Request(`http://localhost/api/tables/${orders}/kanban?${query}`), { params: Promise.resolve({ id: orders }) });
  return { status: response.status, body: await response.json() };
}

describe("kanban", () => {
  it("returns a column per option (no value first) with full counts and a page of cards", async () => {
    const { body } = await board("fieldId=fld_o_status&limit=5");
    const status = getTable(orders)!.fields.find((field) => field.id === "fld_o_status")!;
    expect(body.columns.map((column) => column.key)).toEqual([null, ...(status.type === "singleSelect" ? status.options.map((option) => option.id) : [])]);
    expect(body.columns.reduce((sum, column) => sum + column.count, 0)).toBe(body.total);
    for (const column of body.columns) {
      expect(column.rows.length).toBe(Math.min(5, column.count));
      expect(column.rows.every((row) => (row.values.fld_o_status ?? null) === column.key)).toBe(true);
    }
  });

  it("pages one column with `column` and `offset`, in the view's sort order", async () => {
    const first = await board("viewId=viw_orders_board&fieldId=fld_o_status&limit=10");
    const column = first.body.columns.find((candidate) => candidate.count > 15)!;
    const next = await board(`viewId=viw_orders_board&fieldId=fld_o_status&limit=10&column=${column.key}&offset=10`);
    expect(next.body.columns).toHaveLength(1);
    const dates = [...column.rows, ...next.body.columns[0].rows].map((row) => row.values.fld_o_ordered_at as string);
    expect(dates).toEqual([...dates].sort().reverse());
  });

  it("filters like the grid and refuses a field that isn't a single select", async () => {
    const filter = encodeFilterParam({ conjunction: "and", conditions: [{ fieldId: "fld_o_paid", operator: "isChecked" }], groups: [] });
    const { body } = await board(`fieldId=fld_o_status&filter=${filter}`);
    expect(body.columns.every((column) => column.rows.every((row) => row.values.fld_o_paid === true))).toBe(true);
    expect((await board("fieldId=fld_o_notes")).status).toBe(400);
  });

  it("creates a board stacked by the first single select and saves only a single select as its field", async () => {
    const response = await viewsRoute.POST(new Request(`http://localhost/api/tables/${orders}/views`, { method: "POST", body: JSON.stringify({ kind: "kanban", name: "Board" }) }), {
      params: Promise.resolve({ id: orders }),
    });
    const { view } = (await response.json()) as { view: View };
    expect(view.kanban).toEqual({ fieldId: "fld_o_status" });

    const save = (fieldId: string) =>
      viewRoute.PUT(new Request(`http://localhost/api/views/${view.id}`, { method: "PUT", body: JSON.stringify({ ...view, kanban: { fieldId } }), headers: { "if-match": `"${getView(view.id)!.version}"` } }), {
        params: Promise.resolve({ id: view.id }),
      });
    expect((await save("fld_o_notes")).status).toBe(400);
    expect((await save("fld_o_priority")).status).toBe(200);
  });

  it("forgets its field when the field stops being a single select or is deleted", () => {
    updateField(orders, "fld_o_status", { id: "fld_o_status", name: "Status", type: "text" });
    expect(getView("viw_orders_board")!.view.kanban).toBeUndefined();

    const board = createView(orders, { name: "By channel", kind: "kanban" });
    const stackedBy = board.kanban!.fieldId;
    deleteField(orders, stackedBy, true);
    expect(getView(board.id)!.view.kanban).toBeUndefined();
  });
});
