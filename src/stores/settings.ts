// User-configurable app settings. Persisted in the SQLite `settings` table
// via Rust commands; mirrored here as Solid signals so the UI stays reactive.

import { listen } from "@tauri-apps/api/event";
import { createSignal } from "solid-js";
import { applyTheme } from "../lib/applyTheme";
import {
  DEFAULT_SIDEBAR_PREVIEW_LINES as DEFAULT_SIDEBAR_PREVIEW_LINES_C,
  DEFAULT_TRASH_RETENTION_DAYS,
} from "../lib/constants";
import { api } from "../lib/tauri";
import {
  BUILTIN_THEMES,
  BUILTIN_THEME_IDS,
  DEFAULT_THEME_ID,
  getBuiltin,
} from "../themes";

export type SidebarPreviewLines = 0 | 1 | 2;

const KEY_TRASH_RETENTION = "trash_retention_days";
const KEY_THEME_ID = "theme_id";
/** Legacy key from before the theme system. We migrate `mono` -> theme_id `mono`,
 * everything else -> theme_id `default`. Read-only - never written from new code. */
const KEY_COLOR_MODE_LEGACY = "color_mode";
const KEY_SIDEBAR_PREVIEW_LINES = "sidebar_preview_lines";

const DEFAULT_TRASH_RETENTION = DEFAULT_TRASH_RETENTION_DAYS;
const DEFAULT_SIDEBAR_PREVIEW_LINES: SidebarPreviewLines =
  DEFAULT_SIDEBAR_PREVIEW_LINES_C as SidebarPreviewLines;

const [trashRetentionDays, setTrashRetentionDaysSig] =
  createSignal<number>(DEFAULT_TRASH_RETENTION);
const [themeId, setThemeIdSig] = createSignal<string>(DEFAULT_THEME_ID);
const [sidebarPreviewLines, setSidebarPreviewLinesSig] = createSignal<SidebarPreviewLines>(
  DEFAULT_SIDEBAR_PREVIEW_LINES,
);
const [quickCaptureShortcut, setQuickCaptureShortcutSig] = createSignal<string>("");
const [commandBarShortcut, setCommandBarShortcutSig] = createSignal<string>("");
const [aiTitleEnabled, setAiTitleEnabledSig] = createSignal(false);
const [aiHasKey, setAiHasKeySig] = createSignal(false);
const [aiModel, setAiModelSig] = createSignal<string>("google/gemini-3-flash-preview");
const [loaded, setLoaded] = createSignal(false);

export {
  trashRetentionDays,
  themeId,
  sidebarPreviewLines,
  quickCaptureShortcut,
  commandBarShortcut,
  aiTitleEnabled,
  aiHasKey,
  aiModel,
  loaded as settingsLoaded,
};

/** All themes available to the picker. Phase 1: built-ins only. Phase 2 will
 * merge user-imported themes loaded from disk. */
export function listAvailableThemes() {
  return BUILTIN_THEMES;
}

function applyThemeById(id: string) {
  // Built-ins only in Phase 1. Unknown id falls back to default.
  const theme = getBuiltin(id) ?? getBuiltin(DEFAULT_THEME_ID);
  if (theme) applyTheme(theme);
}

let inFlight: Promise<void> | null = null;

export function loadSettings(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      await loadSettingsImpl();
    } finally {
      // Reset so a follow-up reload (e.g. from the cross-window bridge) can
      // re-fetch instead of returning the cached resolved promise forever.
      inFlight = null;
    }
  })();
  return inFlight;
}

/**
 * Wire up the cross-window settings bridge. The backend emits
 * `notez://settings/changed` whenever any setting (or shortcut) is written;
 * each window that mounted this listener re-loads its in-memory store so
 * its UI catches up with the change.
 *
 * Without this, switching the color mode in the main window would leave the
 * Quick-Capture window's body class out of sync until a full restart.
 *
 * Safe to mount in both windows. Returns the unlisten function so callers
 * who care can clean up; for the App-root mount we just rely on the
 * window's lifecycle to clean up at unload.
 */
export async function registerSettingsBridge(): Promise<() => void> {
  return await listen("notez://settings/changed", () => {
    void loadSettings();
  });
}

async function loadSettingsImpl() {
  const [pairs, shortcuts, aiCfg] = await Promise.all([
    api.listSettings(),
    api.getShortcuts(),
    api.getAiConfig(),
  ]);
  const map = new Map(pairs);

  const retentionRaw = map.get(KEY_TRASH_RETENTION);
  const retention = retentionRaw == null ? DEFAULT_TRASH_RETENTION : Number(retentionRaw);
  setTrashRetentionDaysSig(
    Number.isFinite(retention) && retention >= 0 ? retention : DEFAULT_TRASH_RETENTION,
  );

  // Theme: prefer the new key, fall back to the legacy color_mode for users
  // who upgraded across the rename. Mono is the only legacy non-default value.
  const themeIdRaw = map.get(KEY_THEME_ID);
  const legacyMode = map.get(KEY_COLOR_MODE_LEGACY);
  let resolvedThemeId = DEFAULT_THEME_ID;
  if (themeIdRaw && BUILTIN_THEME_IDS.has(themeIdRaw)) {
    resolvedThemeId = themeIdRaw;
  } else if (themeIdRaw) {
    // Custom theme id - Phase 2 will resolve from disk; for now fall back.
    resolvedThemeId = DEFAULT_THEME_ID;
  } else if (legacyMode === "mono") {
    resolvedThemeId = "mono";
  }
  setThemeIdSig(resolvedThemeId);
  applyThemeById(resolvedThemeId);

  const linesRaw = map.get(KEY_SIDEBAR_PREVIEW_LINES);
  const lines = parseSidebarPreviewLines(linesRaw);
  setSidebarPreviewLinesSig(lines);

  setQuickCaptureShortcutSig(shortcuts.quick_capture);
  setCommandBarShortcutSig(shortcuts.command_bar);

  setAiTitleEnabledSig(aiCfg.enabled);
  setAiHasKeySig(aiCfg.has_key);
  setAiModelSig(aiCfg.model);

  setLoaded(true);
}

export async function setAiTitleEnabled(enabled: boolean) {
  await api.setAiEnabled(enabled);
  setAiTitleEnabledSig(enabled);
}

export async function setOpenrouterApiKey(key: string) {
  await api.setOpenrouterKey(key);
  setAiHasKeySig(key.trim().length > 0);
}

export async function setAiModelChoice(model: string) {
  await api.setAiModel(model);
  setAiModelSig(model);
}

export async function refreshAiConfig() {
  const cfg = await api.getAiConfig();
  setAiTitleEnabledSig(cfg.enabled);
  setAiHasKeySig(cfg.has_key);
  setAiModelSig(cfg.model);
}

export async function setTrashRetentionDays(days: number) {
  const clean = Math.max(0, Math.floor(days));
  await api.setSetting(KEY_TRASH_RETENTION, String(clean));
  setTrashRetentionDaysSig(clean);
}

export async function setActiveTheme(id: string) {
  await api.setSetting(KEY_THEME_ID, id);
  setThemeIdSig(id);
  applyThemeById(id);
}

export async function setSidebarPreviewLines(lines: SidebarPreviewLines) {
  await api.setSetting(KEY_SIDEBAR_PREVIEW_LINES, String(lines));
  setSidebarPreviewLinesSig(lines);
}

function parseSidebarPreviewLines(raw: string | undefined): SidebarPreviewLines {
  if (raw == null) return DEFAULT_SIDEBAR_PREVIEW_LINES;
  const n = Number(raw);
  if (n === 0 || n === 1 || n === 2) return n;
  return DEFAULT_SIDEBAR_PREVIEW_LINES;
}

export async function setQuickCaptureShortcut(accelerator: string) {
  const canonical = await api.updateShortcut("quick_capture", accelerator);
  setQuickCaptureShortcutSig(canonical);
  return canonical;
}

export async function setCommandBarShortcut(accelerator: string) {
  const canonical = await api.updateShortcut("command_bar", accelerator);
  setCommandBarShortcutSig(canonical);
  return canonical;
}

// Convert canonical accelerator ("super+alt+KeyN") to a Mac-style display ("⌘⌥N").
export function formatAccelerator(s: string): string {
  if (!s) return "";
  const parts = s
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  const out: string[] = [];
  for (const p of parts) {
    const lower = p.toLowerCase();
    if (lower === "super" || lower === "cmd" || lower === "command" || lower === "meta") {
      out.push("⌘");
    } else if (lower === "alt" || lower === "option" || lower === "opt") {
      out.push("⌥");
    } else if (lower === "shift") {
      out.push("⇧");
    } else if (lower === "ctrl" || lower === "control") {
      out.push("⌃");
    } else {
      out.push(displayKey(p));
    }
  }
  return out.join("");
}

function displayKey(token: string): string {
  const t = token.toLowerCase();
  if (t.startsWith("key") && t.length === 4) return t.slice(3).toUpperCase();
  if (t.startsWith("digit") && t.length === 6) return t.slice(5);
  switch (t) {
    case "space":
      return "Space";
    case "enter":
    case "return":
      return "↵";
    case "tab":
      return "⇥";
    case "backspace":
      return "⌫";
    case "delete":
    case "del":
      return "⌦";
    case "escape":
    case "esc":
      return "⎋";
    case "minus":
      return "−";
    case "equal":
      return "=";
    case "comma":
      return ",";
    case "period":
    case "dot":
      return ".";
    case "slash":
      return "/";
    case "backslash":
      return "\\";
    case "semicolon":
      return ";";
    case "quote":
      return "'";
    case "backquote":
    case "grave":
      return "`";
    case "bracketleft":
      return "[";
    case "bracketright":
      return "]";
    default:
      return token.toUpperCase();
  }
}

// Convert a KeyboardEvent into a canonical accelerator string acceptable to the
// Rust parser (`super+alt+KeyN`). Returns null if there's no valid key (modifier-only).
export function eventToAccelerator(e: KeyboardEvent): string | null {
  const mods: string[] = [];
  if (e.metaKey) mods.push("super");
  if (e.altKey) mods.push("alt");
  if (e.shiftKey) mods.push("shift");
  if (e.ctrlKey) mods.push("ctrl");
  // Reject modifier-only events.
  const isModifierKey = ["Meta", "Alt", "Shift", "Control", "OS"].includes(e.key);
  if (isModifierKey) return null;
  if (mods.length === 0) return null; // bare-key shortcuts not allowed
  // event.code is layout-independent ("KeyN" regardless of QWERTY/AZERTY).
  if (!e.code) return null;
  return [...mods, e.code].join("+");
}
