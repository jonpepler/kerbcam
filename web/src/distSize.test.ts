/*
 * Guards the single-file index.html against Mediabunny (or any future
 * grouped-recording trim dependency) getting inlined into it. Mediabunny's
 * own pre-built bundle is ~613 KB raw / ~156 KB gz (web/vite.config.ts's
 * copyMediabunnyAsset step, sourced from node_modules/mediabunny/dist/
 * bundles/mediabunny.min.mjs); index.html must stay far under that, and must
 * not contain the package's own source at all.
 *
 * Reads the committed build output directly (web/dist/index.html), same as
 * what the sidecar embeds via include_str! -- this is a regression guard on
 * the shipped artifact, not a fresh-build assertion.
 */

import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const distDir = path.resolve(__dirname, "../dist");
const indexPath = path.join(distDir, "index.html");

describe("dist/index.html stays lean", () => {
  it("exists (run `pnpm --filter kerbcast-web build` first)", () => {
    expect(fs.existsSync(indexPath)).toBe(true);
  });

  it("stays well under Mediabunny's own bundle size", () => {
    const bytes = fs.statSync(indexPath).size;
    // Mediabunny's raw bundle alone is ~613 KB; index.html (app chrome +
    // React + styles, single-file inlined) should be a small fraction of
    // that. 500 KB gives headroom for normal feature growth while still
    // catching an accidental full inline of the trim package.
    expect(bytes).toBeLessThan(500 * 1024);
  });

  it("does not contain Mediabunny's source (never inlined)", () => {
    const html = fs.readFileSync(indexPath, "utf8");
    // "Vanilagy" is Mediabunny's author, present in its license banner;
    // distinctive enough that it can only appear here via an accidental
    // inline of the real package (our own trim-orchestration code only
    // touches a few of its exported property names, e.g. "BlobSource").
    expect(html).not.toContain("Vanilagy");
  });
});

describe("dist/assets/mediabunny.min.mjs is served as its own file", () => {
  const assetPath = path.join(distDir, "assets/mediabunny.min.mjs");

  it("exists as a separate asset next to index.html", () => {
    expect(fs.existsSync(assetPath)).toBe(true);
  });

  it("is the real Mediabunny bundle, not a stub", () => {
    const bytes = fs.statSync(assetPath).size;
    // The real pre-minified bundle is several hundred KB; a placeholder or
    // truncated copy would be nowhere close.
    expect(bytes).toBeGreaterThan(400 * 1024);
  });
});
