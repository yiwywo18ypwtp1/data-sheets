/**
 * Every error carries the 0-based offset in the expression where it happened,
 * so the formula editor can point at it: `Unknown field "Prise" at 14`.
 */
export class FormulaSyntaxError extends Error {
  constructor(
    readonly reason: string,
    readonly position: number,
  ) {
    super(`${reason} at ${position}`);
    this.name = "FormulaSyntaxError";
  }
}

export type Token =
  | { type: "number"; value: number; start: number; end: number }
  | { type: "string"; value: string; start: number; end: number }
  /** `{...}`: the text between the braces, trimmed. A field name in the editor, a field id in storage. */
  | { type: "field"; value: string; start: number; end: number }
  /** Function names and TRUE/FALSE, upper-cased: names are case-insensitive. */
  | { type: "identifier"; value: string; start: number; end: number }
  | { type: "operator"; value: Operator; start: number; end: number }
  | { type: "punctuation"; value: "(" | ")" | ","; start: number; end: number }
  | { type: "eof"; start: number; end: number };

export type Operator = "+" | "-" | "*" | "/" | "&" | "=" | "!=" | "<" | "<=" | ">" | ">=";

const NUMBER = /\d+(\.\d+)?([eE][+-]?\d+)?|\.\d+([eE][+-]?\d+)?/y;
const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]*/y;
const ESCAPES: Record<string, string> = { n: "\n", t: "\t", "\\": "\\", '"': '"', "'": "'" };

function matchAt(regex: RegExp, input: string, position: number): string | null {
  regex.lastIndex = position;
  return regex.exec(input)?.[0] ?? null;
}

export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    const char = input[i];

    if (/\s/.test(char)) {
      i++;
      continue;
    }

    const number = matchAt(NUMBER, input, i);
    if (number) {
      tokens.push({ type: "number", value: Number(number), start: i, end: i + number.length });
      i += number.length;
      continue;
    }

    const identifier = matchAt(IDENTIFIER, input, i);
    if (identifier) {
      tokens.push({ type: "identifier", value: identifier.toUpperCase(), start: i, end: i + identifier.length });
      i += identifier.length;
      continue;
    }

    if (char === '"' || char === "'") {
      const start = i;
      let value = "";
      i++;
      while (i < input.length && input[i] !== char) {
        if (input[i] === "\\" && i + 1 < input.length) {
          value += ESCAPES[input[i + 1]] ?? input[i + 1];
          i += 2;
        } else {
          value += input[i++];
        }
      }
      if (i >= input.length) throw new FormulaSyntaxError("Unterminated string", start);
      i++; // closing quote
      tokens.push({ type: "string", value, start, end: i });
      continue;
    }

    if (char === "{") {
      const close = input.indexOf("}", i + 1);
      if (close === -1) throw new FormulaSyntaxError("Unterminated field reference", i);
      const value = input.slice(i + 1, close).trim();
      if (value === "") throw new FormulaSyntaxError("Empty field reference", i);
      tokens.push({ type: "field", value, start: i, end: close + 1 });
      i = close + 1;
      continue;
    }

    const twoChars = input.slice(i, i + 2);
    if (twoChars === "!=" || twoChars === "<>" || twoChars === "<=" || twoChars === ">=") {
      // `<>` is accepted as a spreadsheet-style alias of `!=`
      tokens.push({ type: "operator", value: twoChars === "<>" ? "!=" : twoChars, start: i, end: i + 2 });
      i += 2;
      continue;
    }

    if (char === "+" || char === "-" || char === "*" || char === "/" || char === "&" || char === "=" || char === "<" || char === ">") {
      tokens.push({ type: "operator", value: char, start: i, end: i + 1 });
      i++;
      continue;
    }

    if (char === "(" || char === ")" || char === ",") {
      tokens.push({ type: "punctuation", value: char, start: i, end: i + 1 });
      i++;
      continue;
    }

    throw new FormulaSyntaxError(`Unexpected character "${char}"`, i);
  }

  tokens.push({ type: "eof", start: input.length, end: input.length });
  return tokens;
}
