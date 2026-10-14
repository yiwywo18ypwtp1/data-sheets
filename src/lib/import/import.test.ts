import { describe, expect, it } from "vitest";
import type { Field } from "@/lib/domain/field";
import { detectEncoding } from "./encoding";
import { autoMap, buildRowSchema, draftField, importTargets, inferType, mappingSchemaFor, rowInput, type ColumnMapping } from "./mapping";

const uk = { locale: "uk-UA", timeZone: "Europe/Kyiv" };
const en = { locale: "en-US", timeZone: "America/Los_Angeles" };

describe("detectEncoding", () => {
  const utf8 = new TextEncoder().encode("Назва;Ціна\nКава;12,50\n");
  // "Назва;Ціна" in Windows-1251.
  const cp1251 = new Uint8Array([0xcd, 0xe0, 0xe7, 0xe2, 0xe0, 0x3b, 0xd6, 0xb3, 0xed, 0xe0, 0x0a]);

  it("recognises BOMs", () => {
    expect(detectEncoding(new Uint8Array([0xef, 0xbb, 0xbf, 0x41]))).toEqual({ encoding: "utf-8", bomLength: 3 });
    expect(detectEncoding(new Uint8Array([0xff, 0xfe, 0x41, 0x00]))).toEqual({ encoding: "utf-16le", bomLength: 2 });
  });

  it("tells UTF-8 from Windows-1251 Cyrillic", () => {
    expect(detectEncoding(utf8).encoding).toBe("utf-8");
    expect(detectEncoding(cp1251).encoding).toBe("windows-1251");
    expect(new TextDecoder("windows-1251").decode(cp1251)).toBe("Назва;Ціна\n");
  });

  it("doesn't mistake a UTF-8 character cut off at the end of the sample for 1251", () => {
    expect(detectEncoding(utf8.subarray(0, 3)).encoding).toBe("utf-8"); // "Н" + half of "а"
  });
});

describe("inferType", () => {
  it.each<[string[], string]>([
    [["1 234,50", "12", ""], "number"],
    [["так", "ні", "1"], "checkbox"],
    [["1", "0", "1"], "number"],
    [["12.03.2026", "2026-01-31"], "date"],
    [["12.03.2026 14:30", "01.01.2026 00:00"], "dateTime"],
    [["a@b.co", "x@y.org"], "email"],
    [["https://a.com", "http://b.org/x"], "url"],
    [["Kyiv", "12"], "text"],
    // One bad value among many doesn't change the type: it becomes an error to fix in step 3.
    [[...Array.from({ length: 12 }, (_, i) => `${i + 1}.03.2026`), "32.03.2026"], "date"],
    [[], "text"],
  ])("%j → %s", (samples, type) => {
    expect(inferType(samples, uk)).toBe(type);
  });
});

const fields: Field[] = [
  { id: "fld_name", name: "Name", type: "text" },
  { id: "fld_qty", name: "Qty", type: "number", precision: 0 },
  { id: "fld_total", name: "Total", type: "formula", expression: "{fld_qty}", resultType: "number" },
  { id: "fld_customer", name: "Customer", type: "link", targetTableId: "tbl_c", multiple: false },
];

describe("autoMap", () => {
  it("matches headers to importable fields by name, each once, and creates the rest", () => {
    let n = 0;
    const mapping = autoMap(["name", "QTY", "Total", "Customer", "Name", ""], fields, () => ["5"], uk, () => `fld_new${++n}`);
    expect(mapping[0]).toEqual({ action: "existing", fieldId: "fld_name" });
    expect(mapping[1]).toEqual({ action: "existing", fieldId: "fld_qty" });
    // Computed and link fields aren't import targets: a new field is proposed, named so it doesn't clash.
    expect(mapping[2]).toMatchObject({ action: "new", name: "Total (import)", type: "number" });
    expect(mapping[3]).toMatchObject({ action: "new", name: "Customer (import)" });
    expect(mapping[4]).toMatchObject({ action: "new", name: "Name (import)" });
    expect(mapping[5]).toMatchObject({ action: "new", name: "Column 6" });
  });
});

describe("mappingSchemaFor", () => {
  const schema = mappingSchemaFor(fields);
  const issues = (columns: ColumnMapping[]) => schema.safeParse({ columns }).error?.issues.map((issue) => [issue.path.join("."), issue.message]);

  it("forbids two columns going into one field", () => {
    expect(issues([{ action: "existing", fieldId: "fld_qty" }, { action: "existing", fieldId: "fld_qty" }])).toEqual([
      ["columns.1.fieldId", "Column 1 already goes into “Qty”"],
    ]);
  });

  it("checks new names against existing fields and each other", () => {
    expect(
      issues([
        { action: "new", newFieldId: "a", name: "qty", type: "text" },
        { action: "new", newFieldId: "b", name: "Notes", type: "text" },
        { action: "new", newFieldId: "c", name: "notes ", type: "text" },
      ])?.map(([path]) => path),
    ).toEqual(["columns.0.name", "columns.2.name"]);
  });

  it("rejects computed targets and an import of nothing", () => {
    expect(issues([{ action: "existing", fieldId: "fld_total" }])?.[0][0]).toBe("columns.0.fieldId");
    expect(issues([{ action: "skip" }])).toEqual([["columns", "Choose at least one column to import"]]);
  });
});

describe("draftField", () => {
  it("builds select options from distinct values and number precision from the data", () => {
    const select = draftField({ action: "new", newFieldId: "fld_s", name: "Status", type: "singleSelect" }, ["Done", "done ", "", "Open"], uk);
    expect(select).toMatchObject({ type: "singleSelect", options: [{ label: "Done" }, { label: "Open" }] });
    expect(draftField({ action: "new", newFieldId: "fld_n", name: "Price", type: "number" }, ["1,234", "2.5"], en)).toMatchObject({ precision: 1 });
  });

  it("refuses a select with too many different values", () => {
    const values = Array.from({ length: 201 }, (_, i) => `v${i}`);
    expect(() => draftField({ action: "new", newFieldId: "fld_s", name: "S", type: "singleSelect" }, values, uk)).toThrow(/201 different values/);
  });
});

describe("buildRowSchema", () => {
  const targets = [
    { column: 0, header: "Name", field: fields[0] },
    { column: 2, header: "Qty", field: fields[1] },
  ];
  const schema = buildRowSchema(targets, uk);

  it("converts a CSV row into cell values", () => {
    expect(schema.parse(rowInput(targets, ["Кава", "ignored", "1 234"]))).toEqual({ fld_name: "Кава", fld_qty: 1234 });
  });

  it("reports values that can't be converted on their field, and uses overrides", () => {
    const result = schema.safeParse(rowInput(targets, ["Кава", "", "дванадцять"]));
    expect(result.error?.issues.map((issue) => [issue.path[0], issue.message])).toEqual([["fld_qty", '"дванадцять" is not a number']]);
    expect(schema.parse(rowInput(targets, ["Кава", "", "дванадцять"], (column) => (column === 2 ? "12" : undefined)))).toMatchObject({ fld_qty: 12 });
  });
});

describe("importTargets", () => {
  it("pairs mapped columns with existing fields and drafts of new ones, skipping the rest", () => {
    const targets = importTargets(
      [{ action: "existing", fieldId: "fld_qty" }, { action: "skip" }, { action: "new", newFieldId: "fld_new", name: "Price", type: "number" }],
      ["Qty", "Ignored", "Price"],
      fields,
      () => ["1,5", "2"],
      uk,
    );
    expect(targets.map((target) => [target.column, target.field.id])).toEqual([
      [0, "fld_qty"],
      [2, "fld_new"],
    ]);
    expect(targets[1].field).toMatchObject({ type: "number", precision: 1 });
  });
});
