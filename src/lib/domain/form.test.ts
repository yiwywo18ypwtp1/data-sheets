import { describe, expect, it } from "vitest";
import type { Field } from "./field";
import { formAnswersSchema, formVersion, visibleQuestions, type FormConfig } from "./form";

const fields: Field[] = [
  { id: "name", name: "Name", type: "text" },
  { id: "company", name: "Company?", type: "checkbox" },
  { id: "size", name: "Size", type: "singleSelect", options: [{ id: "s", label: "Small", color: "#000000" }, { id: "l", label: "Large", color: "#000000" }] },
  { id: "budget", name: "Budget", type: "number", precision: 2 },
  { id: "notes", name: "Notes", type: "text" },
];
const config: FormConfig = {
  title: "Lead",
  description: "",
  submitLabel: "Send",
  successMessage: "Thanks",
  fields: [
    { fieldId: "name", required: true },
    { fieldId: "company", required: false },
    { fieldId: "size", required: true, showIf: { fieldId: "company", values: ["true"] } },
    { fieldId: "budget", required: true, showIf: { fieldId: "size", values: ["l"] } },
    { fieldId: "gone", required: true },
  ],
};
const uk = { locale: "uk-UA", timeZone: "Europe/Kyiv" };

describe("visibleQuestions", () => {
  it("shows a question only when its controlling answer matches, in chains", () => {
    const ids = (answers: Record<string, string | boolean>) => visibleQuestions(config, fields, answers).map((question) => question.fieldId);
    expect(ids({})).toEqual(["name", "company"]);
    expect(ids({ company: true })).toEqual(["name", "company", "size"]);
    expect(ids({ company: true, size: "l" })).toEqual(["name", "company", "size", "budget"]);
    // The size answer stays in the form, but its question is hidden, so budget is hidden too.
    expect(ids({ company: false, size: "l" })).toEqual(["name", "company"]);
  });
});

describe("formAnswersSchema", () => {
  const schema = formAnswersSchema(config, fields, uk);

  it("converts the visible answers into cell values, dropping hidden ones", () => {
    expect(schema.parse({ name: "Ada", company: true, size: "l", budget: "1 234,5" })).toEqual({ name: "Ada", company: true, size: "l", budget: 1234.5 });
    // An unchecked box is stored as empty, like everywhere else.
    expect(schema.parse({ name: "Ada", company: false, size: "l", budget: "oops" })).toEqual({ name: "Ada" });
  });

  it("requires visible required questions and checks values", () => {
    // An untouched radio group is null in the form.
    expect(schema.safeParse({ name: "Ada", company: true, size: null }).error?.issues.map((issue) => issue.message)).toEqual(["This question is required"]);
    const issues = schema.safeParse({ company: true, size: "x" }).error?.issues.map((issue) => [issue.path[0], issue.message]);
    expect(issues).toEqual([
      ["name", "This question is required"],
      ["size", "Unknown option"],
    ]);
  });
});

describe("formVersion", () => {
  it("changes when the form or one of its fields changes, not for other fields", () => {
    const base = formVersion(config, fields);
    expect(formVersion(config, [...fields, { id: "other", name: "Other", type: "text" }])).toBe(base);
    expect(formVersion(config, fields.map((field) => (field.id === "budget" ? { ...field, precision: 0 } : field)))).not.toBe(base);
    expect(formVersion({ ...config, title: "Lead 2" }, fields)).not.toBe(base);
  });
});
