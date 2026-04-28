// User-configurable app settings. Persisted in the SQLite `settings` table
// via Rust commands; mirrored here as Solid signals so the UI stays reactive.

import { createSignal } from "solid-js";
import { api } from "../lib/tauri";

export type ColorMode = "default" | "mono";

const KEY_TRASH_RETENTION = "trash_retention_days";
const KEY_COLOR_MODE = "color_mode";

const DEFAULT_TRASH_RETENTION = 30; // days; 0 = never auto-delete
const DEFAULT_COLOR_MODE: ColorMode = "default";

const [trashRetentionDays, setTrashRetentionDaysSig] = createSignal<number>(
  DEFAULT_TRASH_RETENTION,
);
const [colorMode, setColorModeSig] = createSignal<ColorMode>(DEFAULT_COLOR_MODE);
const [quickCaptureShortcut, setQuickCaptureShortcutSig] = createSignal<string>("");
const [commandBarShortcut, setCommandBarShortcutSig] = createSignal<string>("");
const [loaded, setLoaded] = createSignal(false);

export {
  trashRetentionDays,
  colorMode,
  quickCaptureShortcut,
  commandBarShortcut,
  loaded as settingsLoaded,
};

function applyColorModeClass(mode: ColorMode) {
  const root = document.documentElement;
  if (mode === "mono") root.classList.add("nz-mono");
  else root.classList.remove("nz-mono");
}

let inFlight: Promise<void> | null = null;

export function loadSettings(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    await loadSettingsImpl();
  })();
  return inFlight;
}

async function loadSettingsImpl() {
  const [pairs, shortcuts] = await Promise.all([
    api.listSettings(),
    api.getShortcuts(),
  ]);
  const map = new Map(pairs);

  const retentionRaw = map.get(KEY_TRASH_RETENTION);
  const retention = retentionRaw == null ? DEFAULT_TRASH_RETENTION : Number(retentionRaw);
  setTrashRetentionDaysSig(Number.isFinite(retention) && retention >= 0
    ? retention
    : DEFAULT_TRASH_RETENTION);

  const modeRaw = map.get(KEY_COLOR_MODE);
  const mode: ColorMode = modeRaw === "mono" ? "mono" : "default";
  setColorModeSig(mode);
  applyColorModeClass(mode);

  setQuickCaptureShortcutSig(shortcuts.quick_capture);
  setCommandBarShortcutSig(shortcuts.command_bar);
  setLoaded(true);
}

export async function setTrashRetentionDays(days: number) {
  const clean = Math.max(0, Math.floor(days));
  await api.setSetting(KEY_TRASH_RETENTION, String(clean));
  setTrashRetentionDaysSig(clean);
}

export async function setColorMode(mode: ColorMode) {
  await api.setSetting(KEY_COLOR_MODE, mode);
  setColorModeSig(mode);
  applyColorModeClass(mode);
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
  const parts = s.split("+").map((p) => p.trim()).filter(Boolean);
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
    case "space": return "Space";
    case "enter":
    case "return": return "↵";
    case "tab": return "⇥";
    case "backspace": return "⌫";
    case "delete":
    case "del": return "⌦";
    case "escape":
    case "esc": return "⎋";
    case "minus": return "−";
    case "equal": return "=";
    case "comma": return ",";
    case "period":
    case "dot": return ".";
    case "slash": return "/";
    case "backslash": return "\\";
    case "semicolon": return ";";
    case "quote": return "'";
    case "backquote":
    case "grave": return "`";
    case "bracketleft": return "[";
    case "bracketright": return "]";
    default: return token.toUpperCase();
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
