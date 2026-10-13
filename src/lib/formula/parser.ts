import { FormulaSyntaxError, tokenize, type Operator, type Token } from "./lexer";

export type BinaryOperator = Operator;

/** `start` is kept on every node so later stages (type check) can report positions too. */
export type Node =
  | { kind: "number"; value: number; start: number }
  | { kind: "string"; value: string; start: number }
  | { kind: "boolean"; value: boolean; start: number }
  | { kind: "field"; ref: string; start: number }
  | { kind: "negate"; operand: Node; start: number }
  | { kind: "binary"; operator: BinaryOperator; left: Node; right: Node; start: number }
  | { kind: "call"; name: string; args: Node[]; start: number };

/** Deep nesting is legal (200 brackets must work) but bounded, so a hostile formula can't overflow the stack. */
export const MAX_NESTING = 256;

/** Binding power per operator; higher binds tighter. All binary operators are left-associative. */
const BINDING_POWER: Record<BinaryOperator, number> = {
  "=": 10,
  "!=": 10,
  "<": 10,
  "<=": 10,
  ">": 10,
  ">=": 10,
  "&": 20,
  "+": 30,
  "-": 30,
  "*": 40,
  "/": 40,
};
const PREFIX_BINDING_POWER = 50;

function isPunctuation(token: Token, value: "(" | ")" | ","): boolean {
  return token.type === "punctuation" && token.value === value;
}

function describe(token: Token): string {
  if (token.type === "eof") return "end of formula";
  if (token.type === "string") return "text";
  if (token.type === "field") return "field reference";
  return `"${token.value}"`;
}

/**
 * Pratt parser: each step parses a prefix expression (literal, field, call,
 * parenthesised expression or unary minus), then keeps folding in binary
 * operators while they bind tighter than the caller's minimum binding power.
 */
export function parse(input: string): Node {
  const tokens = tokenize(input);
  let index = 0;

  const peek = () => tokens[index];
  const next = () => tokens[index++];

  function expect(value: "(" | ")"): Token {
    const token = next();
    if (!isPunctuation(token, value)) {
      throw new FormulaSyntaxError(`Expected "${value}" but found ${describe(token)}`, token.start);
    }
    return token;
  }

  function parseExpression(minBindingPower: number, depth: number): Node {
    if (depth > MAX_NESTING) throw new FormulaSyntaxError("Formula is nested too deeply", peek().start);

    let left = parsePrefix(depth);
    for (;;) {
      const token = peek();
      if (token.type !== "operator") break;
      const power = BINDING_POWER[token.value];
      if (power <= minBindingPower) break;
      next();
      const right = parseExpression(power, depth + 1);
      left = { kind: "binary", operator: token.value, left, right, start: token.start };
    }
    return left;
  }

  function parsePrefix(depth: number): Node {
    const token = next();
    switch (token.type) {
      case "number":
        return { kind: "number", value: token.value, start: token.start };
      case "string":
        return { kind: "string", value: token.value, start: token.start };
      case "field":
        return { kind: "field", ref: token.value, start: token.start };
      case "operator":
        if (token.value === "-") {
          return { kind: "negate", operand: parseExpression(PREFIX_BINDING_POWER, depth + 1), start: token.start };
        }
        if (token.value === "+") return parseExpression(PREFIX_BINDING_POWER, depth + 1);
        break;
      case "punctuation":
        if (token.value === "(") {
          const inner = parseExpression(0, depth + 1);
          expect(")");
          return inner;
        }
        break;
      case "identifier":
        if (token.value === "TRUE" || token.value === "FALSE") {
          return { kind: "boolean", value: token.value === "TRUE", start: token.start };
        }
        if (isPunctuation(peek(), "(")) {
          return parseCall(token.value, token.start, depth);
        }
        throw new FormulaSyntaxError(`Unknown name "${token.value}" (field names go in braces)`, token.start);
    }
    throw new FormulaSyntaxError(`Unexpected ${describe(token)}`, token.start);
  }

  function parseCall(name: string, start: number, depth: number): Node {
    expect("(");
    const args: Node[] = [];
    if (!isPunctuation(peek(), ")")) {
      for (;;) {
        args.push(parseExpression(0, depth + 1));
        if (!isPunctuation(peek(), ",")) break;
        next();
      }
    }
    expect(")");
    return { kind: "call", name, args, start };
  }

  if (input.trim() === "") throw new FormulaSyntaxError("Formula is empty", 0);
  const ast = parseExpression(0, 0);
  const rest = peek();
  if (rest.type !== "eof") throw new FormulaSyntaxError(`Unexpected ${describe(rest)}`, rest.start);
  return ast;
}
