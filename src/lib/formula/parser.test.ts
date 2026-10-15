import { describe, expect, it } from "vitest";
import { FormulaSyntaxError, tokenize } from "./lexer";
import { MAX_NESTING, parse, type Node } from "./parser";

/** Renders an AST as an S-expression so precedence is easy to read in assertions. */
function show(node: Node): string {
  switch (node.kind) {
    case "number":
    case "boolean":
      return String(node.value);
    case "string":
      return JSON.stringify(node.value);
    case "field":
      return `{${node.ref}}`;
    case "negate":
      return `(- ${show(node.operand)})`;
    case "binary":
      return `(${node.operator} ${show(node.left)} ${show(node.right)})`;
    case "call":
      return `(${node.name}${node.args.map((arg) => ` ${show(arg)}`).join("")})`;
  }
}

function syntaxError(expression: string): FormulaSyntaxError {
  try {
    parse(expression);
  } catch (error) {
    if (error instanceof FormulaSyntaxError) return error;
    throw error;
  }
  throw new Error(`Expected "${expression}" to fail`);
}

describe("tokenize", () => {
  it("reads numbers, strings with escapes, field refs and operators", () => {
    const tokens = tokenize(`1.5e2 "a\\"b" { Unit price } <> <= &`);
    expect(tokens.map((token) => ("value" in token ? token.value : token.type))).toEqual([
      150,
      'a"b',
      "Unit price",
      "!=",
      "<=",
      "&",
      "eof",
    ]);
  });

  it("keeps braces inside strings as text", () => {
    expect(tokenize(`"{not a field}"`)[0]).toMatchObject({ type: "string", value: "{not a field}" });
  });

  it("reports positions of lexical errors", () => {
    expect(() => tokenize(`1 + "abc`)).toThrow("Unterminated string at 4");
    expect(() => tokenize(`{Price`)).toThrow("Unterminated field reference at 0");
    expect(() => tokenize(`1 # 2`)).toThrow('Unexpected character "#" at 2');
  });

  it("handles a 100 000 character string literal", () => {
    const tokens = tokenize(`"${"x".repeat(100_000)}"`);
    expect(tokens[0]).toMatchObject({ type: "string" });
  });
});

describe("parse", () => {
  it.each([
    ["1 + 2 * 3", "(+ 1 (* 2 3))"],
    ["(1 + 2) * 3", "(* (+ 1 2) 3)"],
    ["10 - 4 - 3", "(- (- 10 4) 3)"],
    ["-2 * 3", "(* (- 2) 3)"],
    ["{A} & \" \" & {B}", '(& (& {A} " ") {B})'],
    ["1 + 2 = 3", "(= (+ 1 2) 3)"],
    ["{a} & 1 + 2", "(& {a} (+ 1 2))"],
    ["if(true, 1)", "(IF true 1)"],
    ["TODAY()", "(TODAY)"],
    ['IF({Status} = "Done", {Price} * {Qty}, 0)', '(IF (= {Status} "Done") (* {Price} {Qty}) 0)'],
  ])("%s → %s", (expression, expected) => {
    expect(show(parse(expression))).toBe(expected);
  });

  it("parses 200 nested brackets", () => {
    expect(show(parse(`${"(".repeat(200)}1${")".repeat(200)}`))).toBe("1");
  });

  it("rejects absurd nesting instead of overflowing the stack", () => {
    const deep = `${"(".repeat(MAX_NESTING + 10)}1${")".repeat(MAX_NESTING + 10)}`;
    expect(syntaxError(deep).reason).toBe("Formula is nested too deeply");
  });

  it("doesn't count operator chains as nesting: a chain is bounded by the formula length only", () => {
    expect(show(parse(`1${"+1".repeat(MAX_NESTING - 1)}`))).toMatch(/^\(\+ /);
    expect(show(parse(`1${"+1".repeat(4999)}`))).toMatch(/^\(\+ /);
  });

  it.each([
    ["", "Formula is empty", 0],
    ["1 +", "Unexpected end of formula", 3],
    ["(1 + 2", 'Expected ")" but found end of formula', 6],
    ["1 2", 'Unexpected "2"', 2],
    ["SUM(1,)", 'Unexpected ")"', 6],
    ["Price * 2", 'Unknown name "PRICE" (field names go in braces)', 0],
  ])("reports %j as %s at %i", (expression, reason, position) => {
    const error = syntaxError(expression);
    expect(error.reason).toBe(reason);
    expect(error.position).toBe(position);
  });
});
