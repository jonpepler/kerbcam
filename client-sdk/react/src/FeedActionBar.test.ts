/**
 * Tests for the FeedActionBar overflow-partition logic (issue #6 UI spec).
 *
 * Pure-function tests only; the rendered FeedActionBar component (built-in
 * wiring through CameraFeed / KerbalFaceFeed) is covered by their own test
 * suites, which exercise the real DOM output (the ⋮ trigger, the portaled
 * overflow menu, stable ordering across enable/disable toggles).
 */

import { describe, expect, it } from "vitest";
import { partitionActionBarEntries } from "./FeedActionBar";

interface Entry {
  id: string;
  stateful?: boolean;
  order?: number;
  pinnedTrailing?: boolean;
}

function ids(entries: Entry[]): string[] {
  return entries.map((e) => e.id);
}

describe("partitionActionBarEntries", () => {
  it("keeps everything primary (inline) when total enabled < 4", () => {
    const entries: Entry[] = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const { primary, overflow } = partitionActionBarEntries(entries);
    expect(ids(primary)).toEqual(["a", "b", "c"]);
    expect(overflow).toEqual([]);
  });

  it("collapses non-stateful entries into overflow at exactly the 4/2 threshold", () => {
    const entries: Entry[] = [
      { id: "tracking", stateful: true },
      { id: "quality" },
      { id: "pip" },
      { id: "fullscreen" },
    ];
    const { primary, overflow } = partitionActionBarEntries(entries);
    expect(ids(primary)).toEqual(["tracking"]);
    expect(ids(overflow)).toEqual(["quality", "pip", "fullscreen"]);
  });

  it("never collapses a single non-stateful item, even with total >= 4", () => {
    const entries: Entry[] = [
      { id: "tracking", stateful: true },
      { id: "rec", stateful: true },
      { id: "close", stateful: true },
      { id: "quality" }, // the only non-stateful eligible item
    ];
    const { primary, overflow } = partitionActionBarEntries(entries);
    expect(ids(primary)).toEqual(["tracking", "rec", "close", "quality"]);
    expect(overflow).toEqual([]);
  });

  it("stays inline when total is below 4 even with 2+ non-stateful eligible", () => {
    const entries: Entry[] = [{ id: "quality" }, { id: "pip" }];
    const { primary, overflow } = partitionActionBarEntries(entries);
    expect(ids(primary)).toEqual(["quality", "pip"]);
    expect(overflow).toEqual([]);
  });

  it("stays inline just under the total threshold (3 total, 3 non-stateful)", () => {
    const entries: Entry[] = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const { primary, overflow } = partitionActionBarEntries(entries);
    expect(ids(primary)).toEqual(["a", "b", "c"]);
    expect(overflow).toEqual([]);
  });

  it("all-stateful entries never overflow regardless of count", () => {
    const entries: Entry[] = [
      { id: "a", stateful: true },
      { id: "b", stateful: true },
      { id: "c", stateful: true },
      { id: "d", stateful: true },
      { id: "e", stateful: true },
    ];
    const { primary, overflow } = partitionActionBarEntries(entries);
    expect(ids(primary)).toEqual(["a", "b", "c", "d", "e"]);
    expect(overflow).toEqual([]);
  });

  it("sorts by explicit order first, then preserves stable relative order for the rest", () => {
    const entries: Entry[] = [
      { id: "custom", order: 0 },
      { id: "quality" },
      { id: "tracking", stateful: true },
      { id: "pip" },
      { id: "fullscreen" },
    ];
    const { primary, overflow } = partitionActionBarEntries(entries);
    // "custom" (order: 0) sorts first; the rest keep their input order.
    expect(ids(primary)).toEqual(["tracking"]);
    expect(ids(overflow)).toEqual(["custom", "quality", "pip", "fullscreen"]);
  });

  it("does not reflow the remaining chips' relative order when one is disabled", () => {
    // Simulates a re-render where "pip" is no longer enabled (simply omitted).
    // "help" here is just a generic non-stateful, non-pinned example action --
    // NOT the close/remove slot (that's covered in its own describe block
    // below, since it is excluded from this count entirely).
    const before: Entry[] = [
      { id: "tracking", stateful: true },
      { id: "quality" },
      { id: "pip" },
      { id: "fullscreen" },
      { id: "help" },
    ];
    const after: Entry[] = [
      { id: "tracking", stateful: true },
      { id: "quality" },
      { id: "fullscreen" },
      { id: "help" },
    ];
    const beforeResult = partitionActionBarEntries(before);
    const afterResult = partitionActionBarEntries(after);
    expect(ids(beforeResult.overflow)).toEqual(["quality", "pip", "fullscreen", "help"]);
    // "pip" drops out; "quality", "fullscreen", "help" keep the same relative order.
    expect(ids(afterResult.overflow)).toEqual(["quality", "fullscreen", "help"]);
  });

  it("preserves the partition's relative order (stateful entries interspersed in input)", () => {
    const entries: Entry[] = [
      { id: "quality" },
      { id: "tracking", stateful: true },
      { id: "pip" },
      { id: "rec", stateful: true },
      { id: "fullscreen" },
    ];
    const { primary, overflow } = partitionActionBarEntries(entries);
    expect(ids(primary)).toEqual(["tracking", "rec"]);
    expect(ids(overflow)).toEqual(["quality", "pip", "fullscreen"]);
  });
});

describe("partitionActionBarEntries -- pinnedTrailing (close/remove)", () => {
  it("returns a pinnedTrailing entry in its own group, separate from primary/overflow", () => {
    const entries: Entry[] = [
      { id: "spotlight", stateful: true },
      { id: "close", pinnedTrailing: true },
    ];
    const { primary, overflow, pinnedTrailing } = partitionActionBarEntries(entries);
    expect(ids(primary)).toEqual(["spotlight"]);
    expect(overflow).toEqual([]);
    expect(ids(pinnedTrailing)).toEqual(["close"]);
  });

  it("excludes pinnedTrailing from BOTH the total and the non-stateful-eligible count", () => {
    // Same 4 actions CrewBar wires per face: spotlight (stateful), fullscreen,
    // pip (both non-stateful, overflow-eligible), close (pinned). Naively
    // counting close toward the total would hit the 4/2 threshold; excluding
    // it drops the non-pinned total to 3, so overflow does NOT trigger --
    // fullscreen/pip stay primary, and close is still separate (never inline
    // with them, never counted).
    const entries: Entry[] = [
      { id: "spotlight", stateful: true },
      { id: "fullscreen" },
      { id: "pip" },
      { id: "close", pinnedTrailing: true },
    ];
    const { primary, overflow, pinnedTrailing } = partitionActionBarEntries(entries);
    expect(ids(primary)).toEqual(["spotlight", "fullscreen", "pip"]);
    expect(overflow).toEqual([]);
    expect(ids(pinnedTrailing)).toEqual(["close"]);
  });

  it("still triggers overflow on the remaining set once it alone crosses the threshold", () => {
    // The Tile.tsx / CameraFeed shape: spotlight + quality + tracking + pip +
    // fullscreen + remove (pinned). Excluding "remove", the remaining 5
    // actions (3 non-stateful: quality/pip/fullscreen) still cross 4/2.
    const entries: Entry[] = [
      { id: "spotlight", stateful: true },
      { id: "quality" },
      { id: "tracking", stateful: true },
      { id: "pip" },
      { id: "fullscreen" },
      { id: "remove", pinnedTrailing: true },
    ];
    const { primary, overflow, pinnedTrailing } = partitionActionBarEntries(entries);
    expect(ids(primary)).toEqual(["spotlight", "tracking"]);
    expect(ids(overflow)).toEqual(["quality", "pip", "fullscreen"]);
    expect(ids(pinnedTrailing)).toEqual(["remove"]);
  });

  it("never appears inside the overflow group, even when it is the only non-stateful-looking entry", () => {
    const entries: Entry[] = [
      { id: "a", stateful: true },
      { id: "b", stateful: true },
      { id: "c", stateful: true },
      { id: "close", pinnedTrailing: true },
    ];
    const { overflow, pinnedTrailing } = partitionActionBarEntries(entries);
    expect(overflow).toEqual([]);
    expect(ids(pinnedTrailing)).toEqual(["close"]);
  });
});
