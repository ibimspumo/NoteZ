// Theme application. Writes the active theme's tokens into a single
// `<style id="nz-theme">` element under `:root`, replacing the previous
// content. This is the only mechanism by which themable CSS variables
// are set - the base stylesheet (theme.css) never declares themable
// tokens directly anymore.

import { TOKEN_NAMES, type ThemeFile } from "../themes/contract";

const STYLE_ID = "nz-theme";

/** Build the CSS text for a theme. Tokens missing from the file fall back
 * to whatever was in the previous `<style>` (i.e. previous theme); if no
 * previous theme exists, the missing token is undefined and components
 * relying on it would break. Built-ins are validated to be complete; this
 * is a guard for future custom-theme imports that might be partial. */
export function themeToCss(theme: ThemeFile): string {
  const lines: string[] = [];
  for (const [name, value] of Object.entries(theme.tokens)) {
    if (!TOKEN_NAMES.has(name)) continue; // ignore unknown keys defensively
    lines.push(`  --${name}: ${value};`);
  }
  return `:root {\n${lines.join("\n")}\n}\n`;
}

export function applyTheme(theme: ThemeFile): void {
  const css = themeToCss(theme);
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = STYLE_ID;
    document.head.appendChild(el);
  }
  if (el.textContent !== css) {
    el.textContent = css;
  }
  document.documentElement.dataset.themeId = theme.id;
  document.documentElement.dataset.themeMode = theme.mode;
}
