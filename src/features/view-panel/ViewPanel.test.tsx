// @vitest-environment jsdom
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Field } from "@/lib/domain/field";
import { EMPTY_FILTER } from "@/lib/domain/filter";
import type { View, ViewQuery } from "@/lib/domain/view";
import { ViewPanel } from "./ViewPanel";

const fields: Field[] = [
  { id: "fld_name", name: "Name", type: "text" },
  { id: "fld_qty", name: "Qty", type: "number", precision: 0 },
  { id: "fld_status", name: "Status", type: "singleSelect", options: [{ id: "opt_done", label: "Done", color: "#16a34a" }] },
];
const view: View = { id: "viw_1", name: "All", kind: "grid", filter: EMPTY_FILTER, sorts: [], hiddenFieldIds: [], fieldOrder: [], columnWidths: {}, rowHeight: "short" };

function setup() {
  const onApply = vi.fn<(query: ViewQuery) => void>();
  const save = vi.fn(async (patch: Partial<View>) => ({ ...view, ...patch }));
  render(<ViewPanel open fields={fields} saved={view} save={save} onApply={onApply} onStatusChange={() => {}} linkFilter={null} linkFilterError={null} labelOf={() => undefined} />);
  const lastApplied = () => onApply.mock.calls.at(-1)?.[0];
  return { onApply, save, lastApplied, user: userEvent.setup() };
}

describe("ViewPanel filter tree", () => {
  it("changing a condition's field resets its operator and value to that type's, without leftover keys", async () => {
    const { lastApplied, user } = setup();
    await user.click(screen.getByRole("button", { name: "+ Add condition" }));
    const row = screen.getAllByRole("listitem")[0];
    expect(within(row).getByLabelText("Operator for Name")).toHaveValue("contains");
    await user.type(within(row).getByLabelText("Value for Name"), "lamp");

    await user.selectOptions(within(row).getByLabelText("Field"), "fld_qty");
    const operator = within(row).getByLabelText("Operator for Qty");
    expect(within(operator).getAllByRole("option").map((option) => option.textContent)).toEqual(["=", "≠", "<", ">", "between"]);
    await user.type(within(row).getByLabelText("Value for Qty"), "5");
    await waitFor(() => expect(lastApplied()?.filter.conditions).toEqual([{ fieldId: "fld_qty", operator: "eq", value: 5 }]));

    await user.selectOptions(within(row).getByLabelText("Field"), "fld_status");
    expect(within(row).getByRole("group", { name: "Value for Status" })).toBeInTheDocument();
    await user.click(within(row).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(lastApplied()?.filter.conditions).toEqual([{ fieldId: "fld_status", operator: "isAnyOf", value: ["opt_done"] }]));
  });

  it("shows an invalid range and doesn't apply it", async () => {
    const { lastApplied, user } = setup();
    await user.click(screen.getByRole("button", { name: "+ Add condition" }));
    const row = screen.getAllByRole("listitem")[0];
    await user.selectOptions(within(row).getByLabelText("Field"), "fld_qty");
    await user.selectOptions(within(row).getByLabelText("Operator for Qty"), "between");
    await user.type(within(row).getByLabelText("Value for Qty: from"), "10");
    await user.type(within(row).getByLabelText("Value for Qty: to"), "5");
    expect(await within(row).findByRole("alert")).toHaveTextContent("Max must be greater than or equal to min");
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(lastApplied()?.filter.conditions[0]).not.toMatchObject({ value: { min: 10, max: 5 } });
  });

  it("nests conditions in a group (two levels) and saves the whole tree", async () => {
    const { save, user } = setup();
    await user.click(screen.getByRole("button", { name: "+ Add condition group" }));
    const group = screen.getByRole("group", { name: "Condition group 1" });
    await user.click(within(group).getByRole("button", { name: "+ Add condition" }));
    expect(within(group).getAllByRole("listitem")).toHaveLength(2);
    // Groups have no "add group" of their own: the tree stops at two levels.
    expect(within(group).queryByRole("button", { name: "+ Add condition group" })).toBeNull();

    expect(screen.getByText("Unsaved view changes")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save view" }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0][0].filter?.groups[0].conditions).toHaveLength(2);
    await waitFor(() => expect(screen.queryByText("Unsaved view changes")).toBeNull());
  });
});
