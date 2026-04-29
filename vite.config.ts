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
}));
