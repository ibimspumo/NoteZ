/**
 * Auto-update lifecycle for the in-app updater pill.
 *
 * Architecture
 * ------------
 * Tauri's `tauri-plugin-updater` does the heavy lifting (HTTP fetch of
 * `latest.json`, signature verification, download, in-place install of the
 * new `.app` bundle). This module is the thin Solid-side state machine that
 *   1. polls GitHub once at startup (after a short delay so we don't fight
 *      the boot sequence) and again every hour while the app is running,
 *   2. exposes a single signal the sidebar pill subscribes to, and
 *   3. drives the click → download-with-progress → install + relaunch flow.
 *
 * The check itself is the only network call NoteZ makes (besides the opt-in
 * AI title feature). It hits a fixed GitHub Releases URL that 302-redirects
 * to whichever release is marked "latest", returning the signed
 * `latest.json` manifest. No telemetry is sent in either direction - the
 * request body is empty and the response is the manifest the plugin needs
 * to decide if a newer version exists.
 *
 * If the plugin is not configured yet (e.g. before the very first signed
 * release goes out), `check()` rejects; we swallow the error and stay in
 * the `idle` state so the UI stays clean. Same for offline / GitHub down -
 * the user just sees the plain version label.
 */

import { relaunch } from "@tauri-apps/plugin-process";
import { type Update, check } from "@tauri-apps/plugin-updater";
import { createSignal } from "solid-js";
import { APP_VERSION } from "../lib/version";
import { toast } from "./toasts";

export type UpdateStage =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "installing"
  | "error";

const HOUR_MS = 60 * 60 * 1000;
const STARTUP_DELAY_MS = 30_000;

const [stage, setStage] = createSignal<UpdateStage>("idle");
const [available, setAvailable] = createSignal<Update | null>(null);
const [progress, setProgress] = createSignal<number | null>(null);

export const updateStage = stage;
export const updateAvailable = available;
export const updateProgress = progress;

let pollHandle: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

/** Single-flight check. `manual=true` switches on user-facing feedback
 *  (success toast when up-to-date, error toast on failure). Background
 *  polls stay silent: a perpetually-broken network shouldn't yell every
 *  hour, and "you're already on the newest version" isn't worth a toast
 *  every time the timer fires. */
async function pollOnce(manual = false): Promise<void> {
  if (inFlight) {
    if (manual) toast.info("Update check already in progress…");
    return;
  }
  // If the user is mid-download or already saw an update, don't clobber that
  // state with a fresh check. The available Update object would be replaced
  // and the in-progress download would be orphaned.
  if (stage() === "downloading" || stage() === "installing") return;
  inFlight = true;
  try {
    setStage("checking");
    const update = await check();
    if (update) {
      setAvailable(update);
      setStage("available");
      // No toast on the "available" path - the green pill in the sidebar
      // is the surfacing UI, and a toast on top would be redundant noise.
    } else {
      setAvailable(null);
      // Only flip back to idle if we hadn't already surfaced an update from
      // a prior poll. This avoids a transient "available → idle → available"
      // flicker if GitHub returns 200 then a stale cache.
      if (stage() === "checking") setStage("idle");
      if (manual) toast.success(`NoteZ is up to date (v${APP_VERSION}).`);
    }
  } catch (e) {
    console.warn("update check failed:", e);
    if (stage() === "checking") setStage("idle");
    if (manual) {
      toast.error("Update check failed. Check your internet connection.");
    }
  } finally {
    inFlight = false;
  }
}

/** Start polling. Safe to call multiple times - subsequent calls are no-ops.
 *  In dev we skip entirely: there's no signed release to update from, and
 *  hitting GitHub on every hot-reload is just noise. */
export function startUpdateChecker(): void {
  if (import.meta.env.DEV) return;
  if (pollHandle != null) return;
  // Initial check is delayed so the first paint, DB open, and folder/notes
  // bootstrap aren't competing with a network request for the main thread's
  // attention. After that, hourly per the user's expressed preference.
  setTimeout(() => {
    void pollOnce();
  }, STARTUP_DELAY_MS);
  pollHandle = setInterval(() => {
    void pollOnce();
  }, HOUR_MS);
}

/** Manual re-check. Bound to ⌘-click on the sidebar version label. Surfaces
 *  toast feedback (success when already current, error on network failure)
 *  so the click feels acknowledged even when nothing visually changes. */
export async function checkForUpdatesNow(): Promise<void> {
  await pollOnce(true);
}

/** Click handler for the version pill when an update is available. Drives
 *  the full download → install → relaunch flow with progress reporting. */
export async function downloadAndInstall(): Promise<void> {
  const update = available();
  if (!update) return;
  if (stage() === "downloading" || stage() === "installing") return;

  setStage("downloading");
  setProgress(0);

  let totalBytes = 0;
  let downloadedBytes = 0;

  try {
    await update.downloadAndInstall((event) => {
      switch (event.event) {
        case "Started":
          totalBytes = event.data.contentLength ?? 0;
          downloadedBytes = 0;
          setProgress(0);
          break;
        case "Progress":
          downloadedBytes += event.data.chunkLength;
          if (totalBytes > 0) {
            // Cap at 99 % until "Finished" fires - "100 %" with the app still
            // verifying the bundle on disk feels misleading.
            const pct = Math.min(99, Math.floor((downloadedBytes / totalBytes) * 100));
            setProgress(pct);
          }
          break;
        case "Finished":
          setProgress(100);
          break;
      }
    });

    setStage("installing");
    // The new bundle is in place; relaunch swaps to it. Tauri's relaunch
    // exits the current process and spawns the freshly-installed binary.
    await relaunch();
  } catch (e) {
    console.error("update install failed:", e);
    setStage("error");
    setProgress(null);
    toast.error("Update failed. Try again later or download the new version manually from GitHub.");
    // Drop back to "available" after a beat so the user can retry without
    // refreshing the app. The Update object is still valid.
    setTimeout(() => {
      if (stage() === "error") setStage("available");
    }, 4000);
  }
}
