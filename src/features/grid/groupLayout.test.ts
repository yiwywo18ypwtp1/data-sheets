import { describe, expect, it } from "vitest";
import type { RowGroup } from "@/lib/domain/api";
import { GroupLayout, groupPath } from "./groupLayout";

const group = (level: 0 | 1, key: string, start: number, count: number): RowGroup => ({ level, fieldId: level === 0 ? "status" : "paid", key, start, count, aggregates: {} });
// status A (rows 0-4: paid x 0-1, y 2-4), status B (rows 5-9: paid x 5-9)
const groups = [group(0, "A", 0, 5), group(1, "x", 0, 2), group(1, "y", 2, 3), group(0, "B", 5, 5), group(1, "x", 5, 5)];
const pathA = groupPath(groups[0], null);
const pathAy = groupPath(groups[2], pathA);

const describeAll = (layout: GroupLayout) =>
  Array.from({ length: layout.count }, (_, i) => {
    const item = layout.itemAt(i)!;
    return item.kind === "group" ? `${item.collapsed ? "+" : "-"}${item.group.key}` : String(item.index);
  }).join(" ");

describe("GroupLayout", () => {
  it("is the identity without groups", () => {
    const layout = new GroupLayout(null, 3, new Set());
    expect(describeAll(layout)).toBe("0 1 2");
    expect(layout.displayIndexOf(2)).toBe(2);
  });

  it("puts each group's header before its subgroups and rows", () => {
    const layout = new GroupLayout(groups, 10, new Set());
    expect(describeAll(layout)).toBe("-A -x 0 1 -y 2 3 4 -B -x 5 6 7 8 9");
    expect(layout.displayIndexOf(2)).toBe(5);
    expect(layout.itemAt(5)).toEqual({ kind: "row", index: 2 });
    // Display 4…9 is "-y 2 3 4 -B -x": the server rows to load are 2…4.
    expect(layout.serverRange(4, 9)).toEqual({ first: 2, last: 4 });
  });

  it("hides the rows and subgroups of collapsed groups, keeping their headers", () => {
    const layout = new GroupLayout(groups, 10, new Set([pathAy, groupPath(groups[3], null)]));
    expect(describeAll(layout)).toBe("-A -x 0 1 +y +B");
    expect(layout.displayIndexOf(3)).toBeNull();
    expect(layout.pathsContaining(3)).toEqual([pathA, pathAy]);
    // A collapsed top group hides its subgroups too: "+A -B -x 5 6 7 8 9".
    expect(describeAll(new GroupLayout(groups, 10, new Set([pathA])))).toBe("+A -B -x 5 6 7 8 9");
  });

  it("shows rows added in this session after the groups", () => {
    expect(describeAll(new GroupLayout(groups.slice(0, 1), 7, new Set()))).toBe("-A 0 1 2 3 4 5 6");
  });
});
