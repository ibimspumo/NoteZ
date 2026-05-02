import { createSignal } from "solid-js";
import { TOAST_DEFAULT_MS } from "../lib/constants";

/**
 * Lightweight in-app toast queue.
 *
 * Why a custom queue (and not a library):
 *   - We have ~5 distinct toast moments in the whole app (save failed, AI
 *     fallback, snapshot saved, network error, generic info). A 100-line
 *     primitive beats a 4 KB dependency.
 *   - We want errors to *stick* until dismissed (no auto-hide), and info /
 *     success to auto-hide. Most toast libraries make the dismissal pattern
 *     awkward to customize per-toast.
 *
 * Toasts are rendered by `<ToastHost />` which is mounted once at the App
 * root. Any code anywhere in the renderer can call `toast.error("…")` etc.
 */

export type ToastKind = "info" | "success" | "error";

export type Toast = {
  id: number;
  kind: ToastKind;
  message: string;
  /** Optional action button (e.g. "Retry"). */
  action?: { label: string; onPress: () => void };
};

const [items, setItems] = createSignal<Toast[]>([]);
let nextId = 1;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

export const toasts = items;

function push(
  kind: ToastKind,
  message: string,
  opts?: {
    action?: Toast["action"];
    durationMs?: number;
  },
): number {
  const id = nextId++;
  const t: Toast = { id, kind, message, action: opts?.action };
  setItems((cur) => [...cur, t]);
  // Errors stick until dismissed (or replaced by a retry). Info / success
  // auto-hide so they don't pile up.
  const auto = kind === "error" ? null : (opts?.durationMs ?? TOAST_DEFAULT_MS);
  if (auto != null) {
    const handle = setTimeout(() => dismiss(id), auto);
    timers.set(id, handle);
  }
  return id;
}

export function dismiss(id: number) {
  setItems((cur) => cur.filter((t) => t.id !== id));
  const handle = timers.get(id);
  if (handle != null) {
    clearTimeout(handle);
    timers.delete(id);
  }
}

export const toast = {
  info: (message: string, opts?: Parameters<typeof push>[2]) => push("info", message, opts),
  success: (message: string, opts?: Parameters<typeof push>[2]) => push("success", message, opts),
  error: (message: string, opts?: Parameters<typeof push>[2]) => push("error", message, opts),
  dismiss,
};
