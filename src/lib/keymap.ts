export type Modifier = "mod" | "shift" | "alt";

export type Hotkey = {
  key: string;
  mods: Modifier[];
};

export function matchHotkey(e: KeyboardEvent, hotkey: Hotkey): boolean {
  // On macOS, holding Option turns letter keys into alternate glyphs
  // (e.g. ⌥+D → "∂", ⌥+⇧+D → "Í"), so `e.key` no longer matches the binding.
  // Fall back to `e.code` ("KeyD") which is layout- and modifier-independent.
  const wantKey = hotkey.key.toLowerCase();
  const gotKey = e.key.toLowerCase();
  const codeKey = e.code.startsWith("Key") ? e.code.slice(3).toLowerCase() : "";
  if (gotKey !== wantKey && codeKey !== wantKey) return false;
  const wantMod = hotkey.mods.includes("mod");
  const wantShift = hotkey.mods.includes("shift");
  const wantAlt = hotkey.mods.includes("alt");
  const hasMod = e.metaKey || e.ctrlKey;
  if (wantMod !== hasMod) return false;
  if (wantShift !== e.shiftKey) return false;
  if (wantAlt !== e.altKey) return false;
  return true;
}

export function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  return /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent);
}

export function modSymbol(): string {
  return isMac() ? "⌘" : "Ctrl";
}

export function shortcutLabel(hotkey: Hotkey): string {
  const parts: string[] = [];
  if (hotkey.mods.includes("mod")) parts.push(modSymbol());
  if (hotkey.mods.includes("shift")) parts.push("⇧");
  if (hotkey.mods.includes("alt")) parts.push(isMac() ? "⌥" : "Alt");
  parts.push(hotkey.key.length === 1 ? hotkey.key.toUpperCase() : hotkey.key);
  return parts.join(isMac() ? "" : "+");
}
