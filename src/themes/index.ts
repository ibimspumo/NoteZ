// Built-in theme registry. Built-ins are bundled into the JS, never written to
// disk, never editable. The editor's "Duplicate" action will turn one into a
// fresh custom theme; saving a custom theme over a built-in id is rejected.
//
// User themes (Phase 2) will be merged in at runtime via the Rust commands -
// this module only exposes the immutable built-in set.

import defaultTheme from "./builtins/default.json";
import lightTheme from "./builtins/light.json";
import monoTheme from "./builtins/mono.json";
import type { BuiltinTheme, ThemeFile } from "./contract";

export const BUILTIN_THEMES: readonly BuiltinTheme[] = [
  { ...(defaultTheme as ThemeFile), builtin: true },
  { ...(lightTheme as ThemeFile), builtin: true },
  { ...(monoTheme as ThemeFile), builtin: true },
];

export const BUILTIN_THEME_IDS: ReadonlySet<string> = new Set(BUILTIN_THEMES.map((t) => t.id));

export const DEFAULT_THEME_ID = "default";

export function getBuiltin(id: string): BuiltinTheme | undefined {
  return BUILTIN_THEMES.find((t) => t.id === id);
}

export type { ThemeFile, BuiltinTheme } from "./contract";
