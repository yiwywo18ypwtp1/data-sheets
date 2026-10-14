// @vitest-environment jsdom
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RowWindowResponse } from "@/lib/domain/api";
import type { Field } from "@/lib/domain/field";
import { EMPTY_FILTER } from "@/lib/domain/filter";
import type { RowOp } from "@/lib/domain/row";
import type { View } from "@/lib/domain/view";
import { Grid } from "./Grid";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

const fields: Field[] = [
  { id: "fld_name", name: "Name", type: "text" },
  { id: "fld_qty", name: "Qty", type: "number", precision: 0 },
  { id: "fld_done", name: "Done", type: "checkbox" },
];
const view: View = { id: "viw_1", name: "All", kind: "grid", filter: EMPTY_FILTER, sorts: [], hiddenFieldIds: [], fieldOrder: [], columnWidths: {}, rowHeight: "short" };
const initialWindow: RowWindowResponse = {
  offset: 0,
  total: 5,
  aggregates: { fld_qty: { sum: 15, avg: 3 } },
  linkedLabels: {},
  rows: Array.from({ length: 5 }, (_, i) => ({ id: `row_${i}`, values: { fld_name: `Item ${i}`, fld_qty: i + 1 }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", rev: 1 })),
};

// jsdom has no layout: give elements the size of a screen, so the virtualizer renders rows and columns.
Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 1280 });
Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 800 });

let batches: RowOp[][] = [];
beforeEach(() => {
  batches = [];
  // The API: batches are confirmed as sent; presence and anything else answer "no content".
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (url.endsWith("/rows/batch")) {
      const { ops } = JSON.parse(String(init?.body)) as { ops: RowOp[] };
      batches.push(ops);
      const results = ops.map((op) => ({ ok: true, rowId: op.rowId, row: op.op === "update" ? { ...initialWindow.rows.find((row) => row.id === op.rowId)!, values: { ...op.values }, rev: 2 } : null }));
      return Response.json({ results });
    }
    return new Response(null, { status: 204 });
  });
  // Realtime isn't under test here.
  vi.stubGlobal(
    "EventSource",
    class {
      addEventListener() {}
      close() {}
    },
  );
});
afterEach(() => vi.unstubAllGlobals());

/** A rendered cell by position (rows and columns are virtualized, so they're looked up by their data attributes). */
function cell(row: number, col: number): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-row="${row}"][data-col="${col}"]`);
  if (!element) throw new Error(`Cell ${row}:${col} isn't rendered`);
  return element;
}

function setup() {
  render(<Grid tableId="tbl_1" canEdit canChangeSchema={false} tables={[]} linkFilter={null} linkFilterError={null} importHref={null} tableName="Items" fields={fields} primaryFieldId="fld_name" view={view} viewVersion={1} initialRecordId={null} currentUser={{ id: "usr_editor", name: "Eddie Editor" }} initialWindow={initialWindow} />);
  return userEvent.setup();
}

describe("Grid keyboard and editing", () => {
  it("moves the active cell with the arrow keys, Tab and Cmd+End", async () => {
    const user = setup();
    await user.click(cell(0, 0));
    expect(cell(0, 0)).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowDown}{ArrowRight}");
    expect(cell(1, 1)).toHaveAttribute("aria-selected", "true");
    expect(cell(0, 0)).toHaveAttribute("aria-selected", "false");
    await user.keyboard("{Tab}");
    expect(cell(1, 2)).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Meta>}{ArrowUp}{/Meta}");
    expect(cell(0, 2)).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("grid")).toHaveAttribute("aria-activedescendant", cell(0, 2).id);
  });

  it("Enter edits, Enter saves and moves down; typing replaces; Escape cancels", async () => {
    const user = setup();
    await user.click(cell(0, 0));
    await user.keyboard("{Enter}");
    const editor = screen.getByRole("textbox", { name: "Edit Name" });
    expect(editor).toHaveValue("Item 0");
    await user.clear(editor);
    await user.type(editor, "Lamp{Enter}");
    expect(cell(0, 0)).toHaveTextContent("Lamp");
    expect(cell(1, 0)).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(batches[0]).toEqual([{ op: "update", rowId: "row_0", values: { fld_name: "Lamp" }, rev: 1 }]));

    await user.keyboard("X");
    expect(screen.getByRole("textbox", { name: "Edit Name" })).toHaveValue("X");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("textbox", { name: "Edit Name" })).toBeNull();
    expect(cell(1, 0)).toHaveTextContent("Item 1");
  });

  it("keeps the editor open with the reason for a value that isn't valid", async () => {
    const user = setup();
    await user.click(cell(2, 1));
    await user.keyboard("abc{Enter}");
    expect(screen.getByRole("textbox", { name: "Edit Qty" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent('"abc" is not a number');
    expect(batches).toEqual([]);
  });

  it("Delete clears the selected range in one undoable step", async () => {
    const user = setup();
    await user.click(cell(0, 1));
    await user.keyboard("{Shift>}{ArrowDown}{ArrowDown}{/Shift}{Delete}");
    expect([0, 1, 2].map((row) => cell(row, 1).textContent)).toEqual(["", "", ""]);
    await user.keyboard("{Meta>}z{/Meta}");
    expect([0, 1, 2].map((row) => cell(row, 1).textContent)).toEqual(["1", "2", "3"]);
    expect(within(screen.getByRole("grid")).getAllByRole("status")[0]).toHaveTextContent("Undid 3 cleared cells");
  });
});
