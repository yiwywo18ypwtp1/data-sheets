import type { Field, FormulaResultType } from "@/lib/domain/field";
import { parseDateUnit, parseStoredDate } from "./dates";
import { FUNCTIONS, type ParamKind, type ValueType } from "./functions";
import { FormulaSyntaxError } from "./lexer";
import { parse, type Node } from "./parser";
import { isFormulaError, toNumber } from "./values";

type BinaryNode = Extract<Node, { kind: "binary" }>;
type Checked = { node: Node; type: ValueType };

export type CompiledFormula = {
  /** AST whose field nodes hold field ids, whatever form the source expression used. */
  ast: Node;
  /** Fields this formula reads directly. Edges of the dependency graph. */
  fieldIds: string[];
  resultType: FormulaResultType;
  /** Calls TODAY(), directly or in a sub-expression: the result changes with the clock. */
  volatile: boolean;
};

/**
 * `resolveField` decides what `{...}` means: a field name in the editor
 * (`{Price}`) or a field id in storage (`{fld_x}`). Everything else is shared.
 * Throws `FormulaSyntaxError` with a position for any parse or type error.
 */
export function compileFormula(expression: string, resolveField: (ref: string) => Field | undefined): CompiledFormula {
  const fieldIds = new Set<string>();
  let volatile = false;

  function check(node: Node): Checked {
    switch (node.kind) {
      case "number":
        return { node, type: "number" };
      case "string":
        return { node, type: "text" };
      case "boolean":
        return { node, type: "checkbox" };

      case "field": {
        const field = resolveField(node.ref);
        if (!field) throw new FormulaSyntaxError(`Unknown field "${node.ref}"`, node.start);
        if (field.type === "link") {
          throw new FormulaSyntaxError(`Link field "${field.name}" can't be used in a formula; add a lookup field`, node.start);
        }
        fieldIds.add(field.id);
        return { node: { ...node, ref: field.id }, type: fieldValueType(field) };
      }

      case "negate": {
        const operand = check(node.operand);
        expectKind("number", operand, node.operand);
        return { node: { ...node, operand: operand.node }, type: "number" };
      }

      case "binary":
        return checkBinary(node);

      case "call": {
        const definition = FUNCTIONS[node.name];
        if (!definition) throw new FormulaSyntaxError(`Unknown function "${node.name}"`, node.start);
        const { minArgs, maxArgs } = definition;
        if (node.args.length < minArgs || node.args.length > maxArgs) {
          throw new FormulaSyntaxError(`${node.name} expects ${describeArity(minArgs, maxArgs)}`, node.start);
        }
        if (definition.volatile) volatile = true;
        const args = node.args.map((arg, index) => {
          const checked = check(arg);
          expectKind(definition.params[Math.min(index, definition.params.length - 1)] ?? "any", checked, arg);
          return checked;
        });
        return {
          node: { ...node, args: args.map((arg) => arg.node) },
          type: definition.returns(args.map((arg) => arg.type)),
        };
      }
    }
  }

  /**
   * A chain `1+1+…` is a left-deep tree thousands of levels tall: the left spine is walked
   * in a loop, so only real nesting (brackets, arguments) costs stack.
   */
  function checkBinary(top: BinaryNode): Checked {
    const spine: BinaryNode[] = [];
    let leftmost: Node = top;
    while (leftmost.kind === "binary") {
      spine.push(leftmost);
      leftmost = leftmost.left;
    }
    let left = check(leftmost);
    for (let i = spine.length - 1; i >= 0; i--) {
      const node = spine[i];
      const right = check(node.right);
      const checked = { ...node, left: left.node, right: right.node };
      switch (node.operator) {
        case "+":
        case "-":
        case "*":
        case "/":
          expectKind("number", left, node.left);
          expectKind("number", right, node.right);
          left = { node: checked, type: "number" };
          break;
        case "&":
          left = { node: checked, type: "text" };
          break;
        default:
          left = { node: checked, type: "checkbox" };
      }
    }
    return left;
  }

  const { node, type } = check(parse(expression));
  return { ast: node, fieldIds: [...fieldIds], resultType: type === "blank" ? "text" : type, volatile };
}

function fieldValueType(field: Field): ValueType {
  switch (field.type) {
    case "number":
    case "currency":
      return "number";
    case "date":
      return "date";
    case "checkbox":
      return "checkbox";
    case "formula":
      return field.resultType;
    default:
      return "text";
  }
}

/**
 * Rejects an argument that can never work. Only what is known statically: a text *field*
 * may hold "12", so it passes where a number goes; the literal "a" doesn't.
 */
function expectKind(kind: ParamKind, { type }: Checked, node: Node) {
  const fail = (message: string) => {
    throw new FormulaSyntaxError(message, node.start);
  };
  switch (kind) {
    case "any":
      return;
    case "number":
      if (type === "date") fail("Use DATEADD or DATETIME_DIFF for date math");
      if (node.kind === "string" && isFormulaError(toNumber(node.value))) fail(`Expected a number, found "${node.value.slice(0, 20)}"`);
      return;
    case "date":
      if (type === "number" || type === "checkbox") fail("Expected a date");
      if (node.kind === "string" && node.value !== "" && !parseStoredDate(node.value)) fail(`Expected a date, found "${node.value.slice(0, 20)}"`);
      return;
    case "unit":
      if (node.kind === "string" ? !parseDateUnit(node.value) : node.kind === "number" || node.kind === "boolean") {
        fail('Expected a unit: "seconds", "minutes", "hours", "days", "weeks", "months" or "years"');
      }
      return;
  }
}

function describeArity(min: number, max: number): string {
  const plural = (n: number) => (n === 1 ? "argument" : "arguments");
  if (max === Infinity) return `at least ${min} ${plural(min)}`;
  if (min === max) return `${min} ${plural(min)}`;
  return `${min} to ${max} arguments`;
}

/** Compiles an expression as stored on a formula field (`{fld_x}` references). */
export function compileStoredFormula(expression: string, fieldsById: ReadonlyMap<string, Field>): CompiledFormula {
  return compileFormula(expression, (id) => fieldsById.get(id));
}
