import { createSignal } from "solid-js";

/**
 * Single global clock tick that all relative-time labels read from.
 *
 * Why one signal: the sidebar list, the editor meta-bar, and the command-bar
 * results all show "Nm ago" / "Nh ago" / "Just now" computed from the same
 * `updated_at`. Without a shared reactive `now`, each component captures its
 * mount time and they drift apart - the sidebar showing 22m while the meta
 * bar shows 24m for the same note.
 *
 * Why 60s: `formatRelative` buckets transition at minute granularity for
 * the first hour and hour granularity after that. A 60s tick covers every
 * possible label change exactly once.
 *
 * Why this is safe at 1M notes: the sidebar is virtualized, so only ~30
 * rows are in the DOM at any time. A tick re-evaluates `formatRelative` for
 * the visible rows + the open note + (if open) the command-bar results.
 * Cost is bounded by what's on-screen, not by the database size.
 *
 * Visibility-aware: when the page is hidden (window minimised, app in
 * background, laptop lid closed), we pause the interval so the renderer
 * doesn't spend CPU/wakeups on labels nobody can see. On `visibilitychange`
 * back to visible we tick once immediately so labels jump to the current
 * time, then resume the regular cadence.
 */
const [now, setNow] = createSignal(Date.now());

let intervalHandle: number | null = null;

function startTick() {
  if (intervalHandle != null) return;
  intervalHandle = window.setInterval(() => setNow(Date.now()), 60_000);
}

function stopTick() {
  if (intervalHandle == null) return;
  window.clearInterval(intervalHandle);
  intervalHandle = null;
}

if (typeof window !== "undefined") {
  if (typeof document === "undefined" || !document.hidden) {
    startTick();
  }
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        stopTick();
      } else {
        // Catch up immediately on resume so labels reflect the current time
        // rather than the moment the tick was paused.
        setNow(Date.now());
        startTick();
      }
    });
  }
}

export const nowTick = now;
