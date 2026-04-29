import { defineConfig } from "vitest/config";
import solid from "vite-plugin-solid";

/**
 * Vitest config. We mostly test pure logic (formatters, debounce, save
 * pipeline), so a single happy-dom env covers it. Solid components mount
 * fine in JSDOM via @solidjs/testing-library when needed.
 */
export default defineConfig({
  plugins: [solid()],
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    globals: false,
  },
  define: {
    __APP_VERSION__: JSON.stringify("test-0.0.0"),
  },
});
