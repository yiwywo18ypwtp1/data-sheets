import type { Field } from "@/lib/domain/field";
import { FormulaSyntaxError, tokenize } from "./lexer";

/**
 * Formulas are typed with names (`{Price}`) and stored with ids (`{fld_x}`),
 * so renaming a field doesn't break formulas. Conversion goes through the lexer,
 * not a regex, so braces inside string literals are left alone.
 */
function rewriteFieldRefs(expression: string, replace: (ref: string, start: number) => string): string {
  let result = "";
  let cursor = 0;
  for (const token of tokenize(expression)) {
    if (token.type !== "field") continue;
    result += expression.slice(cursor, token.start) + `{${replace(token.value, token.start)}}`;
    cursor = token.end;
  }
  return result + expression.slice(cursor);
}

/** Names are matched case-insensitively, like field names are unique case-insensitively. */
export function fieldByNameResolver(fields: readonly Field[]): (name: string) => Field | undefined {
  const byName = new Map(fields.map((field) => [field.name.toLowerCase(), field]));
  return (name) => byName.get(name.toLowerCase());
}

/** Throws `FormulaSyntaxError` with the position of the first unknown name. */
export function toStoredExpression(expression: string, fields: readonly Field[]): string {
  const resolve = fieldByNameResolver(fields);
  return rewriteFieldRefs(expression, (name, start) => {
    const field = resolve(name);
    if (!field) throw new FormulaSyntaxError(`Unknown field "${name}"`, start);
    return field.id;
  });
}

/** References to deleted fields are kept as raw ids, so the formula shows where it's broken. */
export function toDisplayExpression(expression: string, fields: readonly Field[]): string {
  const byId = new Map(fields.map((field) => [field.id, field]));
  try {
    return rewriteFieldRefs(expression, (id) => byId.get(id)?.name ?? id);
  } catch {
    return expression;
  }
}

/** Field refs as written, without full parsing. A formula that doesn't even tokenize has none. */
export function referencedFieldRefs(expression: string): string[] {
  try {
    return tokenize(expression).flatMap((token) => (token.type === "field" ? [token.value] : []));
  } catch {
    return [];
  }
}
