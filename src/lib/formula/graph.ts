import type { Field } from "@/lib/domain/field";
import { referencedFieldRefs } from "./references";

/**
 * Field id → ids of the fields it reads. Nodes are fields of all tables (ids are
 * globally unique), so a lookup's edge into another table is an ordinary edge.
 * Plain fields have no outgoing edges.
 */
export type DependencyGraph = Map<string, string[]>;

export function fieldDependencies(field: Field): string[] {
  if (field.type === "formula") return [...new Set(referencedFieldRefs(field.expression))];
  if (field.type === "lookup") return [field.linkFieldId, field.targetFieldId];
  return [];
}

export function buildDependencyGraph(fields: Iterable<Field>): DependencyGraph {
  const graph: DependencyGraph = new Map();
  for (const field of fields) graph.set(field.id, fieldDependencies(field));
  return graph;
}

/**
 * Returns a cycle through `startId` as a path that starts and ends with it
 * (`[total, tax, total]`), or null. Every save is checked, so any cycle a new
 * or edited field creates must pass through that field.
 */
export function findCycle(graph: DependencyGraph, startId: string): string[] | null {
  const visited = new Set<string>();
  const path: string[] = [startId];

  function visit(id: string): boolean {
    for (const dependency of graph.get(id) ?? []) {
      if (dependency === startId) {
        path.push(startId);
        return true;
      }
      if (visited.has(dependency)) continue;
      visited.add(dependency);
      path.push(dependency);
      if (visit(dependency)) return true;
      path.pop();
    }
    return false;
  }

  return visit(startId) ? path : null;
}

/** Fields that transitively read any of `changedIds` (not including the changed fields themselves). */
export function dependentsOf(graph: DependencyGraph, changedIds: Iterable<string>): Set<string> {
  const readers = new Map<string, string[]>();
  for (const [id, dependencies] of graph) {
    for (const dependency of dependencies) {
      if (!readers.has(dependency)) readers.set(dependency, []);
      readers.get(dependency)!.push(id);
    }
  }

  const changed = new Set(changedIds);
  const result = new Set<string>();
  const queue = [...changed];
  while (queue.length > 0) {
    for (const reader of readers.get(queue.shift()!) ?? []) {
      if (result.has(reader) || changed.has(reader)) continue;
      result.add(reader);
      queue.push(reader);
    }
  }
  return result;
}

/**
 * Orders `ids` so every field comes after the fields it reads (Kahn's algorithm).
 * Dependencies outside `ids` are treated as already computed. Fields stuck in a
 * cycle can't be ordered and are left out; they show an error instead of hanging.
 */
export function topologicalOrder(graph: DependencyGraph, ids: Iterable<string>): string[] {
  const subset = new Set(ids);
  const pending = new Map<string, number>();
  const readers = new Map<string, string[]>();

  for (const id of subset) {
    const dependencies = (graph.get(id) ?? []).filter((dependency) => subset.has(dependency));
    pending.set(id, new Set(dependencies).size);
    for (const dependency of new Set(dependencies)) {
      if (!readers.has(dependency)) readers.set(dependency, []);
      readers.get(dependency)!.push(id);
    }
  }

  const ready = [...subset].filter((id) => pending.get(id) === 0);
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const reader of readers.get(id) ?? []) {
      const remaining = pending.get(reader)! - 1;
      pending.set(reader, remaining);
      if (remaining === 0) ready.push(reader);
    }
  }
  return order;
}

/** What to recompute after `changedIds` change: their dependents, in a safe order. */
export function recomputeOrder(graph: DependencyGraph, changedIds: Iterable<string>): string[] {
  return topologicalOrder(graph, dependentsOf(graph, changedIds));
}
