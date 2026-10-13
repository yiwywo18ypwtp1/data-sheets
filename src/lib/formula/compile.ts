import type { Field, FormulaResultType } from "@/lib/domain/field";
import { FUNCTIONS, type ValueType } from "./functions";
import { FormulaSyntaxError } from "./lexer";
import { parse, type Node } from "./parser";

export type CompiledFormula = {
  /** AST whose field nodes hold field ids, whatever form the source expression used. */
  ast: Node;
  /** Fields this formula reads directly. Edges of the dependency graph. */
  fieldIds: string[];
  resultType: FormulaResultType;
};

/**
 * `resolveField` decides what `{...}` means: a field name in the editor
 * (`{Price}`) or a field id in storage (`{fld_x}`). Everything else is shared.
 * Throws `FormulaSyntaxError` with a position for any parse or type error.
 */
export function compileFormula(expression: string, resolveField: (ref: string) => Field | undefined): CompiledFormula {
  const fieldIds = new Set<string>();

  function check(node: Node): { node: Node; type: ValueType } {
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
        rejectDate(operand.type, node.operand.start);
        return { node: { ...node, operand: operand.node }, type: "number" };
      }

      case "binary": {
        const left = check(node.left);
        const right = check(node.right);
        const checked = { ...node, left: left.node, right: right.node };
        switch (node.operator) {
          case "+":
          case "-":
          case "*":
          case "/":
            rejectDate(left.type, node.left.start);
            rejectDate(right.type, node.right.start);
            return { node: checked, type: "number" };
          case "&":
            return { node: checked, type: "text" };
          default:
            return { node: checked, type: "checkbox" };
        }
      }

      case "call": {
        const definition = FUNCTIONS[node.name];
        if (!definition) throw new FormulaSyntaxError(`Unknown function "${node.name}"`, node.start);
        const { minArgs, maxArgs } = definition;
        if (node.args.length < minArgs || node.args.length > maxArgs) {
          throw new FormulaSyntaxError(`${node.name} expects ${describeArity(minArgs, maxArgs)}`, node.start);
        }
        const args = node.args.map(check);
        return {
          node: { ...node, args: args.map((arg) => arg.node) },
          type: definition.returns(args.map((arg) => arg.type)),
        };
      }
    }
  }

  const { node, type } = check(parse(expression));
  return { ast: node, fieldIds: [...fieldIds], resultType: type === "blank" ? "text" : type };
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

function rejectDate(type: ValueType, position: number) {
  if (type === "date") throw new FormulaSyntaxError("Use DATEADD or DATETIME_DIFF for date math", position);
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
