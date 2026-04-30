/**
 * Global guard that forces every external `<a>` click to open in the user's
 * system browser instead of swallowing the navigation inside the Tauri
 * webview.
 *
 * The bug it fixes: a plain `<a href="https://…">` (or even one with an
 * `onClick` that calls `window.open`) is still vulnerable to the webview's
 * **right-click → "Open Link"** menu and to **middle-click**, both of
 * which bypass the JS click handler entirely. Once that fires, the webview
 * navigates *in place* - the entire app UI is replaced by the website, and
 * the user has no way back without restarting NoteZ.
 *
 * Strategy:
 *   1. Capture-phase listeners run before any in-component handler, so we
 *      win even if a child element calls `stopPropagation`.
 *   2. For left- and middle-click on an external `<a>`, we cancel the
 *      default navigation and hand the URL to `tauri-plugin-opener`'s
 *      `openUrl`, which shells out to the OS. (Tauri 2's webview does
 *      *not* route `window.open` to the system browser the way Tauri 1
 *      did - calling it from JS is silently a no-op, which is exactly
 *      the regression that motivated this guard.)
 *   3. For the contextmenu event we cancel the default. The native menu
 *      doesn't open, which removes the "Open Link" path that would
 *      otherwise nuke the app. We accept the tradeoff of losing
 *      copy-link-address on plain anchors; selectable text and the
 *      editor's own context menu are unaffected because the listener
 *      only fires when the event target sits inside an `<a>`.
 *
 * Internal links (`#section`, `javascript:`) are intentionally passed
 * through untouched - those don't navigate the webview to a remote
 * origin.
 */

import { openUrl } from "@tauri-apps/plugin-opener";

function findExternalAnchor(target: EventTarget | null): HTMLAnchorElement | null {
  let el = target instanceof Element ? target : null;
  while (el && !(el instanceof HTMLAnchorElement)) {
    el = el.parentElement;
  }
  if (!el) return null;
  const href = el.getAttribute("href");
  if (!href) return null;
  // In-page anchors and non-navigating schemes don't trigger the
  // load-website-inside-the-app failure mode, so leave them alone.
  if (href.startsWith("#") || href.startsWith("javascript:")) return null;
  return el;
}

function openExternal(href: string): void {
  // tauri-plugin-opener routes through the host OS (open-url on macOS),
  // which is the only reliable way to escape the webview in Tauri 2.
  // Failures (denied permission, malformed URL) are logged but not
  // toasted - by the time the user clicks a link, a stack-trace banner
  // would feel worse than a quietly dead link.
  void openUrl(href).catch((e) => {
    console.warn("openUrl failed:", href, e);
  });
}

let installed = false;

export function installExternalLinkGuard(): void {
  if (installed) return;
  installed = true;

  const handleActivation = (e: MouseEvent) => {
    const a = findExternalAnchor(e.target);
    if (!a) return;
    e.preventDefault();
    e.stopPropagation();
    openExternal(a.href);
  };

  // `click` covers left-click. `auxclick` covers middle-click (and any
  // non-primary button); a plain `click` listener does NOT receive
  // middle-click events in modern browsers, so both are required.
  window.addEventListener("click", handleActivation, true);
  window.addEventListener("auxclick", handleActivation, true);

  window.addEventListener(
    "contextmenu",
    (e) => {
      const a = findExternalAnchor(e.target);
      if (!a) return;
      // Suppress the native context menu over external links. Without this,
      // the "Open Link" entry would navigate the webview in place.
      e.preventDefault();
    },
    true,
  );
}
