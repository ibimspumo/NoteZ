import { createSignal } from "solid-js";
import { api } from "../lib/tauri";

const [sidebarCollapsed, setSidebarCollapsed] = createSignal(false);
export { sidebarCollapsed, setSidebarCollapsed };

/** Sidebar width in pixels. User-resizable via the splitter handle between
 *  sidebar and main; persisted to the settings table on a debounced write so
 *  the layout survives restarts. Bounds enforced by `setSidebarWidth`. */
export const SIDEBAR_WIDTH_DEFAULT = 248;
export const SIDEBAR_WIDTH_MIN = 200;
export const SIDEBAR_WIDTH_MAX = 480;
const SETTING_KEY_SIDEBAR_WIDTH = "sidebar_width";

const [sidebarWidth, setSidebarWidthSig] = createSignal<number>(SIDEBAR_WIDTH_DEFAULT);
export { sidebarWidth };

let sidebarWidthPersistTimer: number | null = null;

/** Update the sidebar width, clamping to bounds and debouncing the persist. */
export function setSidebarWidth(px: number) {
  const clamped = Math.round(Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, px)));
  setSidebarWidthSig(clamped);
  if (sidebarWidthPersistTimer != null) clearTimeout(sidebarWidthPersistTimer);
  sidebarWidthPersistTimer = window.setTimeout(() => {
    sidebarWidthPersistTimer = null;
    void api.setSetting(SETTING_KEY_SIDEBAR_WIDTH, String(clamped)).catch((e) => {
      console.warn("sidebar_width persist failed:", e);
    });
  }, 300);
}

/** Read the persisted sidebar width on app start. Falls back silently to the
 *  default if the value is missing or unparseable. */
export async function loadSidebarWidth(): Promise<void> {
  try {
    const raw = await api.getSetting(SETTING_KEY_SIDEBAR_WIDTH);
    if (!raw) return;
    const n = Number(raw);
    if (!Number.isFinite(n)) return;
    const clamped = Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, n));
    setSidebarWidthSig(clamped);
  } catch (e) {
    console.warn("loadSidebarWidth failed:", e);
  }
}

const [commandBarOpen, setCommandBarOpen] = createSignal(false);
export { commandBarOpen, setCommandBarOpen };

const [settingsOpen, setSettingsOpen] = createSignal(false);
export { settingsOpen, setSettingsOpen };

/** The note whose snapshot history is currently open, or null when the
 *  dialog is closed. Lives here (not in MainView's local state) because the
 *  trigger lives in each tab's meta-bar - any tab in any pane can open the
 *  dialog for its own note, no "active note" coupling. */
const [snapshotsTargetId, setSnapshotsTargetIdSig] = createSignal<string | null>(null);
export { snapshotsTargetId };

const [theme, setTheme] = createSignal<"light" | "dark" | "system">("system");
export { theme, setTheme };

export function toggleSidebar() {
  setSidebarCollapsed((v) => !v);
}

export function openCommandBar() {
  setCommandBarOpen(true);
}

export function closeCommandBar() {
  setCommandBarOpen(false);
}

export function openSettings() {
  setSettingsOpen(true);
}

export function closeSettings() {
  setSettingsOpen(false);
}

export function openSnapshotsFor(noteId: string | null) {
  setSnapshotsTargetIdSig(noteId);
}

export function closeSnapshots() {
  setSnapshotsTargetIdSig(null);
}
