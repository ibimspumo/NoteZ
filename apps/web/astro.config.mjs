import { defineConfig } from "astro/config";

// Static site - deploys to Cloudflare Pages.
// take-notez.com is the canonical host; the build emits to ./dist/.
export default defineConfig({
  site: "https://take-notez.com",
  output: "static",
  trailingSlash: "never",
  build: {
    inlineStylesheets: "auto",
  },
  compressHTML: true,
});
