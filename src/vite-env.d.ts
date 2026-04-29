/// <reference types="vite/client" />

/** Injected by Vite's `define`. Reads from `package.json` at build time so the
 *  in-app label always matches the published version without a separate
 *  hand-maintained constant. */
declare const __APP_VERSION__: string;
