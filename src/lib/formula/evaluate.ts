import type { CellValue } from "@/lib/domain/cell";
import type { Field, FormulaResultType } from "@/lib/domain/field";
import { compileStoredFormula, type CompiledFormula } from "./compile";
import { parseStoredDate } from "./dates";
import { FUNCTIONS, type EvalContext } from "./functions";
import { FormulaSyntaxError } from "./lexer";
import type { BinaryOperator, Node } from "./parser";
import {
  formulaError,
  fromCellValue,
  isFormulaDate,
  isFormulaError,
  toNumber,
  toText,
  type FormulaError,
  type FormulaValue,
} from "./values";

export type { EvalContext } from "./functions";

type PlainValue = Exclude<FormulaValue, FormulaError>;

/** `getValue` returns what formulas see for a field id in the current row. */
export function evaluate(formula: CompiledFormula, getValue: (fieldId: string) => FormulaValue, context: EvalContext): FormulaValue {
  function run(node: Node): FormulaValue {
    switch (node.kind) {
      case "number":
      case "string":
      case "boolean":
        return node.value;
      case "field":
        return getValue(node.ref);
      case "negate": {
        const value = run(node.operand);
        if (isFormulaError(value)) return value;
        const number = toNumber(value);
        return isFormulaError(number) ? number : -number;
      }
      case "binary": {
        const left = run(node.left);
        if (isFormulaError(left)) return left;
        const right = run(node.right);
        if (isFormulaError(right)) return right;
        return applyBinary(node.operator, left, right);
      }
      case "call":
        return FUNCTIONS[node.name].evaluate(
          node.args.map((arg) => () => run(arg)),
          context,
        );
    }
  }
  return toResultType(run(formula.ast), formula.resultType);
}

/**
 * Makes the result match the formula's declared type, which filters and sorting rely on:
 * `IF(…, "a", 2)` is a text formula, so its 2 is stored as "2". Numbers lose binary
 * noise (0.1 + 0.2 is 0.3), so a filter `= 4680.65` matches the value the grid shows.
 */
function toResultType(value: FormulaValue, resultType: FormulaResultType): FormulaValue {
  if (value === null || isFormulaError(value)) return value;
  if (resultType === "text" && typeof value !== "string") return toText(value);
  if (typeof value === "number") return Number(value.toPrecision(15));
  return value;
}

function applyBinary(operator: BinaryOperator, left: PlainValue, right: PlainValue): FormulaValue {
  switch (operator) {
    case "&":
      return toText(left) + toText(right);
    case "=":
      return valuesEqual(left, right);
    case "!=":
      return !valuesEqual(left, right);
    case "<":
    case "<=":
    case ">":
    case ">=":
      return compareOrdered(operator, left, right);
    case "+":
    case "-":
    case "*":
    case "/": {
      const a = toNumber(left);
      if (isFormulaError(a)) return a;
      const b = toNumber(right);
      if (isFormulaError(b)) return b;
      if (operator === "/" && b === 0) return formulaError("#DIV/0!", "Division by zero");
      const result = operator === "+" ? a + b : operator === "-" ? a - b : operator === "*" ? a * b : a / b;
      return Number.isFinite(result) ? result : formulaError("#NUM!", "Number is out of range");
    }
  }
}

/**
 * Brings two values to a common comparable form: both numbers (numbers, booleans,
 * dates as ms, numeric text) or both strings. Returns null when they can't be compared.
 */
function comparable(left: PlainValue, right: PlainValue): [number, number] | [string, string] | null {
  if (isFormulaDate(left) || isFormulaDate(right)) {
    const toMs = (value: PlainValue) =>
      isFormulaDate(value) ? value.ms : typeof value === "string" ? (parseStoredDate(value)?.ms ?? null) : null;
    const a = toMs(left);
    const b = toMs(right);
    return a === null || b === null ? null : [a, b];
  }
  if (typeof left === "string" && typeof right === "string") return [left, right];
  const a = toNumber(left);
  const b = toNumber(right);
  return isFormulaError(a) || isFormulaError(b) ? null : [a, b];
}

const isBlank = (value: PlainValue) => value === null || value === "";

function valuesEqual(left: PlainValue, right: PlainValue): boolean {
  // A blank equals only blank or empty text: `{Qty} = 0` is false for an empty Qty.
  if (isBlank(left) || isBlank(right)) return isBlank(left) && isBlank(right);
  const pair = comparable(left, right);
  return pair !== null && pair[0] === pair[1];
}

function compareOrdered(operator: "<" | "<=" | ">" | ">=", left: PlainValue, right: PlainValue): FormulaValue {
  // Blank is neither less nor greater than anything, so rows with empty cells don't match `{Qty} < 5`.
  if (left === null || right === null) return false;
  const pair = comparable(left, right);
  if (!pair) return formulaError("#VALUE!", "Values can't be compared");
  const [a, b] = pair;
  switch (operator) {
    case "<":
      return a < b;
    case "<=":
      return a <= b;
    case ">":
      return a > b;
    case ">=":
      return a >= b;
  }
}

/** A formula that no longer compiles (e.g. a referenced field was deleted) evaluates to this error. */
export function brokenFormulaError(error: unknown): FormulaError {
  const message = error instanceof FormulaSyntaxError ? error.reason : "Invalid formula";
  return formulaError("#REF!", message);
}

/**
 * Evaluates the given formula fields for one row, in the given (dependency) order.
 * Later formulas read earlier results directly, so dates and errors keep their type.
 * Used by the server on write and by the client for optimistic recompute.
 */
export function evaluateRowFormulas(
  formulaIdsInOrder: readonly string[],
  values: Readonly<Record<string, CellValue>>,
  fieldsById: ReadonlyMap<string, Field>,
  context: EvalContext,
  compiled: Map<string, CompiledFormula | FormulaError> = new Map(),
): Map<string, FormulaValue> {
  const results = new Map<string, FormulaValue>();

  const getValue = (fieldId: string): FormulaValue => {
    if (results.has(fieldId)) return results.get(fieldId)!;
    const field = fieldsById.get(fieldId);
    return field ? fromCellValue(field, values[fieldId]) : formulaError("#REF!", "Field was deleted");
  };

  for (const id of formulaIdsInOrder) {
    const field = fieldsById.get(id);
    if (field?.type !== "formula") continue;
    if (!compiled.has(id)) {
      try {
        compiled.set(id, compileStoredFormula(field.expression, fieldsById));
      } catch (error) {
        compiled.set(id, brokenFormulaError(error));
      }
    }
    const formula = compiled.get(id)!;
    results.set(id, "ast" in formula ? evaluate(formula, getValue, context) : formula);
  }
  return results;
}
