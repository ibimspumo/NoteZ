import { createSignal } from "solid-js";

/**
 * Single global clock tick that all relative-time labels read from.
 *
 * Two signals are exposed:
 *
 *   - `nowTick` ticks every 60 s. Cheap subscribers (per-row `formatRelative`
 *     in the visible viewport - virtualized to ~30 rows) read this so
 *     "Nm ago" / "Nh ago" labels stay live without drift.
 *
 *   - `dayTick` ticks at most once an hour, AND only when the local calendar
 *     day actually changes from the previous tick. Heavyweight bucketing
 *     work (Sidebar's Today/Yesterday/This week grouping) hangs off this so
 *     it doesn't pay the per-minute reconciliation cost - bucket membership
 *     is invariant inside a day. Without this split, a 5 000-row sidebar
 *     loaded prefix re-buckets every minute (300 k allocations/h) for no
 *     observable change.
 *
 * Visibility-aware: when the page is hidden (window minimised, app in
 * background, laptop lid closed), we pause both intervals. On
 * `visibilitychange` back to visible we tick once immediately so labels jump
 * to the current time, then resume the regular cadence. We also force a
 * day-tick if the calendar day has actually rolled over while hidden.
 */
const [now, setNow] = createSignal(Date.now());
// Coarse "what day is it" signal - invalidated only when the local calendar
// day flips (or the user resumes the app on a different day). Subscribers
// don't need to read its value; the existence of the signal change is the
// signal.
const [dayKey, setDayKey] = createSignal(localDayKey(Date.now()));

function localDayKey(ms: number): number {
  // Use the local-tz midnight ms as the "key". Identity check (=== prev)
  // is a single integer compare, no Date allocation per consumer.
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

let minuteHandle: number | null = null;
let hourHandle: number | null = null;

function tickMinute() {
  const t = Date.now();
  setNow(t);
  // Cheap day-rollover guard: even minute ticks may catch a day change if
  // the hourly handle drifted (sleep/wake skew). Single integer compare.
  const k = localDayKey(t);
  if (k !== dayKey()) setDayKey(k);
}

function tickHour() {
  const k = localDayKey(Date.now());
  if (k !== dayKey()) setDayKey(k);
}

function startTick() {
  if (minuteHandle == null) {
    minuteHandle = window.setInterval(tickMinute, 60_000);
  }
  if (hourHandle == null) {
    hourHandle = window.setInterval(tickHour, 60 * 60_000);
  }
}

function stopTick() {
  if (minuteHandle != null) {
    window.clearInterval(minuteHandle);
    minuteHandle = null;
  }
  if (hourHandle != null) {
    window.clearInterval(hourHandle);
    hourHandle = null;
  }
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
        tickMinute();
        startTick();
      }
    });
  }
}

export const nowTick = now;
export const dayTick = dayKey;
