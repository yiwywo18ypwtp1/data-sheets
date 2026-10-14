import type { Field } from "@/lib/domain/field";
import { FUNCTIONS } from "@/lib/formula/functions";

/**
 * Editor support for formulas: token classes for highlighting, and what to suggest at
 * the caret. Unlike the real lexer these never throw: the editor must highlight a
 * half-typed, invalid formula too.
 */

export type TokenClass = "field" | "unknownField" | "function" | "string" | "number" | "operator" | "punctuation" | "text";
export type HighlightToken = { text: string; kind: TokenClass };

const PATTERNS: [TokenClass | "identifier" | "fieldRef", RegExp][] = [
  ["fieldRef", /\{[^}]*\}?/y],
  ["string", /"(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?/y],
  ["number", /\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\.\d+/y],
  ["identifier", /[A-Za-z_][A-Za-z0-9_]*/y],
  ["operator", /!=|<>|<=|>=|[-+*/&=<>]/y],
  ["punctuation", /[(),]/y],
];

export function highlight(expression: string, fieldNames: Set<string>): HighlightToken[] {
  const tokens: HighlightToken[] = [];
  let i = 0;
  while (i < expression.length) {
    let matched = false;
    for (const [kind, pattern] of PATTERNS) {
      pattern.lastIndex = i;
      const match = pattern.exec(expression);
      if (!match) continue;
      const text = match[0];
      if (kind === "fieldRef") {
        const name = text.replace(/^\{|\}$/g, "").trim().toLowerCase();
        tokens.push({ text, kind: text.endsWith("}") && fieldNames.has(name) ? "field" : "unknownField" });
      } else if (kind === "identifier") {
        const upper = text.toUpperCase();
        tokens.push({ text, kind: upper in FUNCTIONS || upper === "TRUE" || upper === "FALSE" ? "function" : "text" });
      } else {
        tokens.push({ text, kind });
      }
      i += text.length;
      matched = true;
      break;
    }
    if (!matched) {
      // Whitespace and anything unknown: plain text, merged with the previous plain token.
      const last = tokens.at(-1);
      if (last?.kind === "text") last.text += expression[i];
      else tokens.push({ text: expression[i], kind: "text" });
      i++;
    }
  }
  return tokens;
}

export type Suggestion = { label: string; insert: string; detail: string };
export type Completion = { from: number; to: number; items: Suggestion[] };

const MAX_SUGGESTIONS = 8;

/** Inside a string literal at `caret`? (Quotes before it, ignoring escaped ones.) */
function inString(text: string): boolean {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (char === "\\") i++;
      else if (char === quote) quote = null;
    } else if (char === '"' || char === "'") quote = char;
  }
  return quote !== null;
}

/**
 * Suggestions at the caret: after an unclosed `{`, fields whose names contain what's
 * typed; after letters outside strings and braces, functions starting with them.
 * `from..to` is the text the chosen suggestion replaces.
 */
export function completionAt(expression: string, caret: number, fields: Field[]): Completion | null {
  const before = expression.slice(0, caret);
  if (inString(before)) return null;

  const open = before.lastIndexOf("{");
  if (open !== -1 && before.indexOf("}", open) === -1) {
    const query = before.slice(open + 1).trim().toLowerCase();
    const closing = expression.indexOf("}", caret);
    const nextOpen = expression.indexOf("{", caret);
    const to = closing !== -1 && (nextOpen === -1 || closing < nextOpen) ? closing + 1 : caret;
    const items = fields
      .filter((field) => field.name.toLowerCase().includes(query))
      .sort((a, b) => Number(!a.name.toLowerCase().startsWith(query)) - Number(!b.name.toLowerCase().startsWith(query)))
      .slice(0, MAX_SUGGESTIONS)
      .map((field) => ({ label: field.name, insert: `{${field.name}}`, detail: field.type }));
    return items.length > 0 ? { from: open, to, items } : null;
  }

  const word = /[A-Za-z_][A-Za-z0-9_]*$/.exec(before);
  if (!word) return null;
  const prefix = word[0].toUpperCase();
  const items = Object.keys(FUNCTIONS)
    .filter((name) => name.startsWith(prefix) && name !== prefix)
    .sort()
    .slice(0, MAX_SUGGESTIONS)
    .map((name) => ({ label: name, insert: `${name}(`, detail: "function" }));
  return items.length > 0 ? { from: caret - word[0].length, to: caret, items } : null;
}
