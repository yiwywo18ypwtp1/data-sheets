// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Field } from "@/lib/domain/field";
import { autoMap } from "@/lib/import/mapping";
import { MappingStep } from "./MappingStep";
import type { ParsedCsv } from "./parseCsv";

const fields: Field[] = [
  { id: "fld_name", name: "Name", type: "text" },
  { id: "fld_price", name: "Price", type: "currency", currency: "USD" },
  { id: "fld_total", name: "Total", type: "formula", expression: "{fld_price}", resultType: "number" },
];
const csv: ParsedCsv = {
  file: new File([""], "products.csv"),
  fileName: "products.csv",
  encoding: "utf-8",
  delimiter: ",",
  headers: ["name", "Price", "Added"],
  rows: [
    ["Lamp", "12.5", "12.03.2026"],
    ["Desk", "99", "13.03.2026"],
  ],
};
const options = { locale: "uk-UA", timeZone: "Europe/Kyiv" };
const sample = (column: number) => csv.rows.map((row) => row[column]);

function setup() {
  let n = 0;
  const onNext = vi.fn();
  render(<MappingStep csv={csv} fields={fields} sample={sample} initial={autoMap(csv.headers, fields, sample, options, () => `fld_new${++n}`)} {...options} onBack={() => {}} onNext={onNext} />);
  return { onNext, user: userEvent.setup() };
}

describe("MappingStep", () => {
  it("maps columns to fields by name and proposes a typed new field for the rest", async () => {
    const { onNext, user } = setup();
    expect(screen.getByLabelText("Field for name")).toHaveValue("fld_name");
    expect(screen.getByLabelText("Field for Price")).toHaveValue("fld_price");
    expect(screen.getByLabelText("Import Added as")).toHaveValue("new");
    expect(screen.getByLabelText("Type of the new field for Added")).toHaveValue("date");
    // Computed fields aren't offered as targets.
    expect(within(screen.getByLabelText("Field for name")).queryByRole("option", { name: "Total" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Next: check values" }));
    expect(onNext).toHaveBeenCalledWith([
      { action: "existing", fieldId: "fld_name" },
      { action: "existing", fieldId: "fld_price" },
      { action: "new", newFieldId: "fld_new1", name: "Added", type: "date" },
    ]);
  });

  it("doesn't offer a field that another column already goes into", async () => {
    const { user } = setup();
    await user.selectOptions(screen.getByLabelText("Import Added as"), "existing");
    const options = within(screen.getByLabelText("Field for Added"));
    expect(options.getByRole("option", { name: "Name" })).toBeDisabled();
    expect(options.getByRole("option", { name: "Price" })).toBeDisabled();
  });

  it("needs at least one column to import", async () => {
    const { onNext, user } = setup();
    for (const header of ["name", "Price", "Added"]) await user.selectOptions(screen.getByLabelText(`Import ${header} as`), "skip");
    await user.click(screen.getByRole("button", { name: "Next: check values" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose at least one column to import");
    expect(onNext).not.toHaveBeenCalled();
  });

  it("switching a column to a new field resets its settings to that action's", async () => {
    const { user } = setup();
    await user.selectOptions(screen.getByLabelText("Import Price as"), "new");
    expect(screen.getByLabelText("Name of the new field for Price")).toHaveValue("Price");
    await user.click(screen.getByRole("button", { name: "Next: check values" }));
    // "Price" already exists, so a new field can't take its name.
    expect(await screen.findByText("A field with this name already exists; map the column to it instead")).toBeInTheDocument();
  });
});
