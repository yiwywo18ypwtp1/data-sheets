import { describe, expect, it } from "vitest";
import { wallTimeAt, wallTimeToInstant } from "./timezone";

const wall = (text: string) => {
  const [date, time] = text.split(" ");
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  return { year, month, day, hour, minute, second: 0 };
};
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

describe("wallTimeToInstant", () => {
  it("converts ordinary times using the zone's offset at that date", () => {
    expect(iso(wallTimeToInstant(wall("2026-01-15 12:00"), "Europe/Berlin"))).toBe("2026-01-15T11:00:00.000Z");
    expect(iso(wallTimeToInstant(wall("2026-07-01 12:00"), "Europe/Berlin"))).toBe("2026-07-01T10:00:00.000Z");
    expect(iso(wallTimeToInstant(wall("2026-07-01 12:00"), "America/Los_Angeles"))).toBe("2026-07-01T19:00:00.000Z");
    expect(iso(wallTimeToInstant(wall("2026-01-01 00:00"), "Pacific/Auckland"))).toBe("2025-12-31T11:00:00.000Z");
  });

  it("returns null for a time skipped by spring-forward", () => {
    expect(wallTimeToInstant(wall("2026-03-29 02:30"), "Europe/Berlin")).toBeNull();
    expect(iso(wallTimeToInstant(wall("2026-03-29 01:59"), "Europe/Berlin"))).toBe("2026-03-29T00:59:00.000Z");
    expect(iso(wallTimeToInstant(wall("2026-03-29 03:00"), "Europe/Berlin"))).toBe("2026-03-29T01:00:00.000Z");
  });

  it("picks the first occurrence of a time repeated by fall-back", () => {
    // 02:30 happens at 00:30Z (still summer time) and again at 01:30Z
    expect(iso(wallTimeToInstant(wall("2026-10-25 02:30"), "Europe/Berlin"))).toBe("2026-10-25T00:30:00.000Z");
  });
});

describe("wallTimeAt", () => {
  it("shows the wall-clock time in the zone", () => {
    expect(wallTimeAt(Date.UTC(2026, 9, 25, 1, 30), "Europe/Berlin")).toEqual(wall("2026-10-25 02:30"));
    expect(wallTimeAt(Date.UTC(2026, 0, 1, 0, 0), "UTC")).toEqual(wall("2026-01-01 00:00"));
  });
});
