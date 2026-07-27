/*
 * The web page's grouped-recording trim path must resolve to the sidecar's
 * locally served route, not the bare "mediabunny" package specifier. There
 * is no served asset in this unit-test environment (no running sidecar), so
 * the proof is negative: the dynamic import targets exactly
 * MEDIABUNNY_ASSET_URL (never falls back to "mediabunny"), and a load
 * failure degrades to null rather than throwing.
 */

import { describe, expect, it } from "vitest";
import { importMediabunnyAsset, loadLocalMediabunnyTrimmer, MEDIABUNNY_ASSET_URL } from "./mediabunnyAsset";

describe("mediabunnyAsset", () => {
  it("serves from a local sidecar route, not the bare package name", () => {
    expect(MEDIABUNNY_ASSET_URL).toBe("/assets/mediabunny.min.mjs");
    expect(MEDIABUNNY_ASSET_URL).not.toBe("mediabunny");
  });

  it("dynamic-imports exactly the served route (no sidecar running in this test)", async () => {
    await expect(importMediabunnyAsset()).rejects.toSatisfy((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      return message.includes("mediabunny.min.mjs");
    });
  });

  it("degrades to null (never throws) when the local route can't be loaded", async () => {
    await expect(loadLocalMediabunnyTrimmer()).resolves.toBeNull();
  });
});
