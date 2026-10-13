import { describe, expect, it } from "vitest";
import type { Field } from "@/lib/domain/field";
import { buildDependencyGraph, dependentsOf, findCycle, recomputeOrder, topologicalOrder } from "./graph";

const formula = (id: string, expression: string): Field => ({
  id,
  name: id,
  type: "formula",
  expression,
  resultType: "number",
});

// Orders: qty, price, customer (link) → Customers: name, discount; lookup + formulas on top.
const fields: Field[] = [
  { id: "qty", name: "qty", type: "number", precision: 0 },
  { id: "price", name: "price", type: "number", precision: 2 },
  { id: "customer", name: "customer", type: "link", targetTableId: "customers", multiple: false },
  { id: "c_discount", name: "c_discount", type: "number", precision: 2 },
  { id: "discount", name: "discount", type: "lookup", linkFieldId: "customer", targetFieldId: "c_discount" },
  formula("subtotal", "{price} * {qty}"),
  formula("total", "{subtotal} - {discount}"),
  formula("label", '"Qty: " & {qty}'),
];
const graph = buildDependencyGraph(fields);

describe("dependency graph", () => {
  it("recomputes only what depends on the change, in dependency order", () => {
    expect(recomputeOrder(graph, ["price"])).toEqual(["subtotal", "total"]);
    expect(recomputeOrder(graph, ["qty"])).toEqual(["subtotal", "label", "total"]);
    expect(recomputeOrder(graph, ["label"])).toEqual([]);
  });

  it("follows lookups across tables", () => {
    expect(dependentsOf(graph, ["c_discount"])).toEqual(new Set(["discount", "total"]));
    expect(recomputeOrder(graph, ["customer"])).toEqual(["discount", "total"]);
  });

  it("orders a whole table so every formula comes after its inputs", () => {
    const order = topologicalOrder(graph, ["total", "label", "subtotal", "discount"]);
    expect(order.indexOf("subtotal")).toBeLessThan(order.indexOf("total"));
    expect(order.indexOf("discount")).toBeLessThan(order.indexOf("total"));
  });

  it("finds no cycle in an acyclic graph", () => {
    expect(findCycle(graph, "total")).toBeNull();
  });

  it("finds a cycle through three fields with its path", () => {
    const cyclic = buildDependencyGraph([
      ...fields,
      formula("a", "{b} + 1"),
      formula("b", "{c} + 1"),
      formula("c", "{a} + {qty}"),
    ]);
    expect(findCycle(cyclic, "a")).toEqual(["a", "b", "c", "a"]);
    // fields in a cycle can't be ordered; they are left out rather than looping forever
    expect(topologicalOrder(cyclic, ["a", "b", "c", "subtotal"])).toEqual(["subtotal"]);
  });

  it("finds a self reference", () => {
    expect(findCycle(buildDependencyGraph([formula("x", "{x} * 2")]), "x")).toEqual(["x", "x"]);
  });

  it("finds a cycle that goes through a lookup", () => {
    const cyclic = buildDependencyGraph([
      { id: "link", name: "link", type: "link", targetTableId: "other", multiple: false },
      { id: "remote", name: "remote", type: "lookup", linkFieldId: "link", targetFieldId: "other_formula" },
      formula("other_formula", "{local} + 1"),
      formula("local", "{remote}"),
    ]);
    expect(findCycle(cyclic, "local")).toEqual(["local", "remote", "other_formula", "local"]);
  });
});
