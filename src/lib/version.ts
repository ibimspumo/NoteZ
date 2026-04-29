/**
 * App version label. Single source of truth: `package.json#version`, injected
 * at build time by Vite's `define`. See `vite.config.ts` and `vite-env.d.ts`.
 *
 * Keep this re-export so existing call sites don't need to know about the
 * compile-time global; if we ever switch the injection mechanism it changes
 * here, not in every component.
 */
export const APP_VERSION = __APP_VERSION__;
