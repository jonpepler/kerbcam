import fs from "fs";
import { createRequire } from "module";
import path from "path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import checker from "vite-plugin-checker";
import { viteSingleFile } from "vite-plugin-singlefile";

const require = createRequire(import.meta.url);

/*
 * Mediabunny's package.json "exports" map doesn't expose "./package.json" as
 * a subpath, so its root can't be found via require.resolve("mediabunny/
 * package.json") -- walk up from its resolved entry file instead, to the
 * directory literally named "mediabunny" (its package root, whether a
 * pnpm store link or a flat node_modules/mediabunny).
 */
function resolveMediabunnyDir(): string {
  const entry = require.resolve("mediabunny");
  let dir = path.dirname(entry);
  while (path.basename(dir) !== "mediabunny") {
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`could not locate the mediabunny package root from ${entry}`);
    }
    dir = parent;
  }
  return dir;
}

/*
 * Copies Mediabunny's own pre-built, pre-minified ESM bundle
 * (dist/bundles/mediabunny.min.mjs) to dist/assets/mediabunny.min.mjs, so the
 * sidecar can embed it (sidecar/src/signalling.rs, GET
 * /assets/mediabunny.min.mjs) and the page's grouped-recording trim path can
 * dynamic-import it locally: offline/LAN, no CDN. A plain filesystem copy
 * after the main build finishes (closeBundle), not a Rollup input -- it never
 * enters index.html's chunk graph, so vite-plugin-singlefile has nothing of
 * it to inline.
 */
function copyMediabunnyAsset(): Plugin {
  return {
    name: "copy-mediabunny-asset",
    apply: "build",
    closeBundle() {
      const src = path.join(resolveMediabunnyDir(), "dist/bundles/mediabunny.min.mjs");
      const destDir = path.resolve(__dirname, "dist/assets");
      fs.mkdirSync(destDir, { recursive: true });
      fs.copyFileSync(src, path.join(destDir, "mediabunny.min.mjs"));
    },
  };
}

export default defineConfig(({ command }) => ({
  plugins: [
    react(),
    // Typecheck only in dev (build has tsc --noEmit as a separate step)
    ...(command === "serve"
      ? [checker({ typescript: true })]
      : []),
    viteSingleFile(),
    copyMediabunnyAsset(),
  ],
  resolve: {
    alias: {
      "@ksp-gonogo/kerbcast/testing": path.resolve(
        __dirname,
        "../client-sdk/typescript/src/testing/index.ts",
      ),
      "@ksp-gonogo/kerbcast": path.resolve(
        __dirname,
        "../client-sdk/typescript/src/index.ts",
      ),
      "@ksp-gonogo/kerbcast-react": path.resolve(
        __dirname,
        "../client-sdk/react/src/index.ts",
      ),
    },
  },
  build: {
    outDir: "dist",
    rollupOptions: {
      input: "index.html",
      /*
       * Keep the recording trim package (Mediabunny) out of the single-file
       * page. This page's grouped-recording path never resolves the bare
       * "mediabunny" specifier at all -- it uses loadLocalMediabunnyTrimmer
       * (mediabunnyAsset.ts), which dynamic-imports the locally served
       * /assets/mediabunny.min.mjs (see copyMediabunnyAsset above and
       * sidecar/src/signalling.rs) instead. The SDK's own default loader
       * still contains a bare `import("mediabunny")` as dead code on this
       * page (never invoked, since the app always supplies a custom
       * loadTrimmer); marking it external stops Rollup from resolving and
       * inlining the full package into the single-file bundle for that
       * unreachable path.
       */
      external: ["mediabunny"],
    },
  },
  server: {
    proxy: {
      "/cameras": "http://127.0.0.1:8088",
      "/offer": "http://127.0.0.1:8088",
      "/profile": "http://127.0.0.1:8088",
      "/health": "http://127.0.0.1:8088",
      "/ice-config": "http://127.0.0.1:8088",
    },
  },
}));
