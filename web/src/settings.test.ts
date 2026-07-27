import { beforeEach, describe, expect, it } from "vitest";
import { loadRecordFullResolution, saveRecordFullResolution } from "./settings";

describe("record-full-resolution setting", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults to false when nothing is stored", () => {
    expect(loadRecordFullResolution()).toBe(false);
  });

  it("persists true", () => {
    saveRecordFullResolution(true);
    expect(loadRecordFullResolution()).toBe(true);
  });

  it("persists false explicitly (after having been true)", () => {
    saveRecordFullResolution(true);
    saveRecordFullResolution(false);
    expect(loadRecordFullResolution()).toBe(false);
  });
});
