/*
 * Shared elapsed-timer helpers, extracted out of CameraFeed.tsx and
 * RecGroupBar.tsx (formerly duplicated verbatim between the two).
 */

import { describe, expect, it } from "vitest";
import { formatElapsed, nowMs } from "./timing";

describe("formatElapsed", () => {
  it("formats sub-minute durations as 0:ss", () => {
    expect(formatElapsed(3_000)).toBe("0:03");
  });

  it("formats minutes and seconds, zero-padding seconds", () => {
    expect(formatElapsed(65_000)).toBe("1:05");
  });

  it("floors partial seconds", () => {
    expect(formatElapsed(1_999)).toBe("0:01");
  });

  it("clamps negative durations to 0:00", () => {
    expect(formatElapsed(-500)).toBe("0:00");
  });
});

describe("nowMs", () => {
  it("returns a monotonically increasing, non-negative number", () => {
    const a = nowMs();
    const b = nowMs();
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBeGreaterThanOrEqual(a);
  });
});
