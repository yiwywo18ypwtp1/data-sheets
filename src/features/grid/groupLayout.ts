import type { RowGroup } from "@/lib/domain/api";

/**
 * Maps the rows on screen to the server's rows when the view is grouped. The screen shows
 * a header per group and, for expanded groups, their rows; the server's result is the
 * same rows ungrouped (ordered by the group fields first), indexed 0…total-1.
 *
 * The screen is a list of segments (a group header, or a run of consecutive server rows),
 * so with 50 000 rows and a few thousand groups both directions are a binary search, and
 * the virtualizer only ever deals with "display index" numbers. Without groups it's the
 * identity. Everything else in the grid (selection, editing, paste, windows) keeps using
 * server indexes.
 */

export type LayoutItem = { kind: "group"; group: RowGroup; path: string; collapsed: boolean } | { kind: "row"; index: number };

type Segment = { displayStart: number } & ({ kind: "group"; group: RowGroup; path: string; collapsed: boolean } | { kind: "rows"; start: number; count: number });

/** A stable id for a group: its keys from the top, so it survives refetches. */
export function groupPath(group: RowGroup, parent: string | null): string {
  const own = `${group.fieldId}=${JSON.stringify(group.key)}`;
  return parent === null ? own : `${parent}/${own}`;
}

export class GroupLayout {
  readonly count: number;
  private readonly segments: Segment[] = [];
  private readonly rowSegments: Extract<Segment, { kind: "rows" }>[] = [];
  /** Paths of the groups containing each group's rows, for revealing a row. */
  private readonly paths: { start: number; end: number; path: string }[] = [];

  /**
   * `total` is every row the grid has (server rows plus rows added locally); rows past the
   * last group (added in this session) are shown after the groups.
   */
  constructor(
    groups: RowGroup[] | null,
    private readonly total: number,
    collapsed: ReadonlySet<string>,
  ) {
    if (!groups || groups.length === 0) {
      this.count = total;
      return;
    }
    let display = 0;
    const pushRows = (start: number, count: number) => {
      if (count <= 0) return;
      const segment = { kind: "rows" as const, displayStart: display, start, count };
      this.segments.push(segment);
      this.rowSegments.push(segment);
      display += count;
    };

    let topPath = "";
    let topCollapsed = false;
    groups.forEach((group, i) => {
      const hasChildren = group.level === 0 && groups[i + 1]?.level === 1;
      const path = groupPath(group, group.level === 0 ? null : topPath);
      if (group.level === 0) {
        topPath = path;
        topCollapsed = collapsed.has(path);
      } else if (topCollapsed) {
        return; // inside a collapsed group
      }
      const isCollapsed = collapsed.has(path);
      this.segments.push({ kind: "group", displayStart: display++, group, path, collapsed: isCollapsed });
      this.paths.push({ start: group.start, end: group.start + group.count, path });
      if (!isCollapsed && !hasChildren) pushRows(group.start, group.count);
    });
    const grouped = groups.filter((group) => group.level === 0).reduce((sum, group) => sum + group.count, 0);
    pushRows(grouped, total - grouped);
    this.count = display;
  }

  get grouped(): boolean {
    return this.segments.length > 0;
  }

  itemAt(displayIndex: number): LayoutItem | null {
    if (!this.grouped) return displayIndex < this.total ? { kind: "row", index: displayIndex } : null;
    const segment = this.segmentAt(displayIndex);
    if (!segment) return null;
    if (segment.kind === "group") return { kind: "group", group: segment.group, path: segment.path, collapsed: segment.collapsed };
    return { kind: "row", index: segment.start + (displayIndex - segment.displayStart) };
  }

  /** Where a server row is on screen, or null while it's inside a collapsed group. */
  displayIndexOf(index: number): number | null {
    if (!this.grouped) return index;
    let low = 0;
    let high = this.rowSegments.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const segment = this.rowSegments[mid];
      if (index < segment.start) high = mid - 1;
      else if (index >= segment.start + segment.count) low = mid + 1;
      else return segment.displayStart + (index - segment.start);
    }
    return null;
  }

  /** The server rows to load for a range on screen: the rows shown there and the first rows of the groups shown there. */
  serverRange(firstDisplay: number, lastDisplay: number): { first: number; last: number } | null {
    if (!this.grouped) return { first: firstDisplay, last: lastDisplay };
    let first = Infinity;
    let last = -Infinity;
    for (let display = firstDisplay; display <= lastDisplay; ) {
      const segment = this.segmentAt(display);
      if (!segment) break;
      if (segment.kind === "rows") {
        const from = segment.start + (display - segment.displayStart);
        const to = segment.start + Math.min(segment.count - 1, lastDisplay - segment.displayStart);
        first = Math.min(first, from);
        last = Math.max(last, to);
        display = segment.displayStart + segment.count;
      } else {
        display++;
      }
    }
    return first === Infinity ? null : { first, last };
  }

  /** The groups (paths) a server row is in: expanding them makes the row visible. */
  pathsContaining(index: number): string[] {
    return this.paths.filter((entry) => index >= entry.start && index < entry.end).map((entry) => entry.path);
  }

  private segmentAt(displayIndex: number): Segment | null {
    let low = 0;
    let high = this.segments.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const segment = this.segments[mid];
      const length = segment.kind === "group" ? 1 : segment.count;
      if (displayIndex < segment.displayStart) high = mid - 1;
      else if (displayIndex >= segment.displayStart + length) low = mid + 1;
      else return segment;
    }
    return null;
  }
}
