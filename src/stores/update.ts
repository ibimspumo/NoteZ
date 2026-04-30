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

/** Single-flight check. Network failures and "no signing key configured yet"
 *  errors are intentionally silent - the pill simply doesn't appear. */
async function pollOnce(): Promise<void> {
  if (inFlight) return;
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
    } else {
      setAvailable(null);
      // Only flip back to idle if we hadn't already surfaced an update from
      // a prior poll. This avoids a transient "available → idle → available"
      // flicker if GitHub returns 200 then a stale cache.
      if (stage() === "checking") setStage("idle");
    }
  } catch (e) {
    // Don't toast - the user didn't ask for an update check, and a
    // perpetually broken network shouldn't yell every hour.
    console.warn("update check failed:", e);
    if (stage() === "checking") setStage("idle");
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

/** Manual re-check. Wired to the "Check for updates" path in case we ever
 *  add one to the About dialog. Returns once the check resolves. */
export async function checkForUpdatesNow(): Promise<void> {
  await pollOnce();
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
    toast.error(
      "Update fehlgeschlagen. Versuche es später erneut oder lade die neue Version manuell von GitHub.",
    );
    // Drop back to "available" after a beat so the user can retry without
    // refreshing the app. The Update object is still valid.
    setTimeout(() => {
      if (stage() === "error") setStage("available");
    }, 4000);
  }
}
