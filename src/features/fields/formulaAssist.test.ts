import { describe, expect, it } from "vitest";
import type { Field } from "@/lib/domain/field";
import { completionAt, highlight } from "./formulaAssist";

const fields: Field[] = [
  { id: "f1", name: "Price", type: "currency", currency: "USD" },
  { id: "f2", name: "Unit price", type: "number", precision: 2 },
  { id: "f3", name: "Status", type: "text" },
];
const names = new Set(fields.map((field) => field.name.toLowerCase()));

describe("highlight", () => {
  it("classifies tokens and keeps every character", () => {
    const expression = 'IF({Status} = "Done", {Price} * 2, {Prise})';
    const tokens = highlight(expression, names);
    expect(tokens.map((token) => token.text).join("")).toBe(expression);
    expect(tokens.filter((token) => token.kind !== "text" && token.kind !== "punctuation").map((token) => [token.text, token.kind])).toEqual([
      ["IF", "function"],
      ["{Status}", "field"],
      ["=", "operator"],
      ['"Done"', "string"],
      ["{Price}", "field"],
      ["*", "operator"],
      ["2", "number"],
      ["{Prise}", "unknownField"],
    ]);
  });

  it("never throws on half-typed input", () => {
    expect(highlight('CONCAT("abc, {Pri', names).map((token) => token.kind)).toEqual(["function", "punctuation", "string"]);
    expect(highlight("{Pri", names)).toEqual([{ text: "{Pri", kind: "unknownField" }]);
  });
});

describe("completionAt", () => {
  it("suggests fields after an open brace, best matches first, replacing up to the closing brace", () => {
    const text = "{pri} * 2";
    const completion = completionAt(text, 4, fields);
    expect(completion?.items.map((item) => item.label)).toEqual(["Price", "Unit price"]);
    expect(completion).toMatchObject({ from: 0, to: 5 });
  });

  it("suggests functions after letters, but not inside strings or for a complete name", () => {
    expect(completionAt("ROUND({Price}) + da", 19, fields)?.items.map((item) => item.label)).toEqual(["DATEADD", "DATETIME_DIFF"]);
    expect(completionAt('"da', 3, fields)).toBeNull();
    expect(completionAt("TODAY", 5, fields)).toBeNull();
  });
});
