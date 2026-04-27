import { onCleanup, onMount } from "solid-js";
import { matchHotkey, type Hotkey } from "../lib/keymap";

export type ShortcutBinding = {
  hotkey: Hotkey;
  /** Return `true` to indicate the shortcut handled the event (and prevent default). */
  handler: (e: KeyboardEvent) => boolean | void;
};

/**
 * Mounts a window-level keydown listener that dispatches to the first matching
 * binding. First-match-wins so order is significant: put more specific
 * combinations (e.g. `mod+shift+p`) before broader ones (`mod+p`).
 *
 * Bindings can be passed as a static array because the hook reads them once at
 * mount — to react to dynamic state, capture signals inside the handler closures.
 */
export function useShortcuts(bindings: ShortcutBinding[]) {
  onMount(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      for (const binding of bindings) {
        if (matchHotkey(e, binding.hotkey)) {
          const result = binding.handler(e);
          if (result !== false) {
            e.preventDefault();
          }
          return;
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    onCleanup(() => window.removeEventListener("keydown", onKeyDown));
  });
}
