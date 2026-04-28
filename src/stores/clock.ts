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
 * Visibilitychange: when the laptop wakes from sleep we want labels to
 * update immediately, not on the next 60s boundary.
 */
const [now, setNow] = createSignal(Date.now());

if (typeof window !== "undefined") {
  window.setInterval(() => setNow(Date.now()), 60_000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) setNow(Date.now());
  });
}

export const nowTick = now;
