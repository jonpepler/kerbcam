/*
 * Local route the sidecar serves the Mediabunny trim package at (see
 * sidecar/src/signalling.rs's GET /assets/mediabunny.min.mjs and the
 * copy-mediabunny-asset build step in vite.config.ts). A grouped recording's
 * remux-trim dynamic-imports Mediabunny through this route instead of the
 * bare "mediabunny" package specifier the SDK's default loader uses, so
 * grouped recording works offline/LAN on this page, no CDN. Bundler
 * consumers (e.g. gonogo) keep the SDK's default bare-specifier loader.
 */

import { createMediabunnyTrimmerLoader, type TrimmerLoader } from "@ksp-gonogo/kerbcast";

/** Path the sidecar's axum router serves the Mediabunny bundle at. */
export const MEDIABUNNY_ASSET_URL = "/assets/mediabunny.min.mjs";

/*
 * The `@vite-ignore` comment stops Vite from trying to resolve this as a
 * build-time module graph edge -- the target is a route the running sidecar
 * serves, not a file in this project, so there is nothing for the bundler
 * to statically analyse or code-split.
 */
export function importMediabunnyAsset(): Promise<unknown> {
  return import(/* @vite-ignore */ MEDIABUNNY_ASSET_URL);
}

/** Grouped-recording trim loader for this page: served locally, not "mediabunny". */
export const loadLocalMediabunnyTrimmer: TrimmerLoader = createMediabunnyTrimmerLoader(
  importMediabunnyAsset,
);
