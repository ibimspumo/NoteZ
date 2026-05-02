import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// Read the canonical version from package.json once at config-eval time and
// inject it as a global. The renderer reads it via `__APP_VERSION__` so we
// avoid keeping a hand-maintained `src/lib/version.ts` line in lockstep with
// `package.json` / `Cargo.toml` / `tauri.conf.json`.
const pkgUrl = new URL("./package.json", import.meta.url);
const pkg = JSON.parse(readFileSync(fileURLToPath(pkgUrl), "utf-8")) as {
  version: string;
};

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [solid()],

  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },

  build: {
    // Tauri's macOS WebView is current Safari/WebKit (≥17 on supported
    // macOS versions). Targeting `safari17` lets esbuild emit modern
    // syntax without polyfills - native async/await, top-level await,
    // optional chaining, nullish coalescing - shaving ~5% off the bundle.
    // We don't ship to Windows/Linux yet, so a single-target compile is
    // safe.
    target: "safari17",
    // Enable explicit chunk naming so the lazy-loaded views show up as
    // their own chunk in the dist/ directory and the capture window's
    // first paint doesn't carry MainView's deps.
    rollupOptions: {
      output: {
        manualChunks: {
          // Lexical + its plugins are ~150 KB and only the main view
          // touches them. Putting them in their own chunk lets the
          // capture window skip the parse cost on cold start.
          lexical: [
            "lexical",
            "@lexical/code",
            "@lexical/history",
            "@lexical/link",
            "@lexical/list",
            "@lexical/markdown",
            "@lexical/rich-text",
            "@lexical/selection",
            "@lexical/utils",
          ],
        },
      },
    },
  },

  // The dev server pre-bundles deps; force the heavy ones up front so the
  // first navigation doesn't pay the Vite-discovery cost.
  optimizeDeps: {
    include: ["solid-js", "solid-js/store", "solid-js/web", "lexical"],
  },
}));
