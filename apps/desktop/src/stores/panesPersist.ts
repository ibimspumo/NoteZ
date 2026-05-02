import { createEffect, createRoot } from "solid-js";
import { unwrap } from "solid-js/store";
import { type LayoutNode, type PaneId, migrateLegacyLayout } from "../lib/paneTree";
import { api } from "../lib/tauri";
import { activePaneId, panesState, replaceLayout } from "./panes";

const SETTING_KEY = "panes:layout";
const PERSIST_DEBOUNCE_MS = 500;

type Persisted = {
  root: LayoutNode;
  activePaneId: PaneId;
};

/**
 * Read the saved layout from the settings table. Returns null if nothing has
 * been saved or the stored blob can't be parsed - in either case we fall
 * through to the default single-pane layout. The migration step accepts both
 * the old `{ kind: "pane", noteId }` shape and the new
 * `{ kind: "pane", tabs, activeTabIdx }` shape.
 */
export async function loadLayout(): Promise<Persisted | null> {
  try {
    const raw = await api.getSetting(SETTING_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { root?: unknown; activePaneId?: string };
    if (!parsed.root || !parsed.activePaneId) return null;
    const migrated = migrateLegacyLayout(parsed.root);
    return { root: migrated, activePaneId: parsed.activePaneId };
  } catch (e) {
    console.warn("loadLayout: failed to parse saved layout, ignoring", e);
    return null;
  }
}

/**
 * Apply a previously-saved layout. Reconciles against the currently-loaded
 * notes - any tab whose noteId no longer exists has its noteId nulled (the
 * tab stays so the user's tab topology is preserved; the empty picker takes
 * over for that tab). The defensive try/catch in the per-tab editor handles
 * the rare case of a hard-deleted note still being referenced when the load
 * actually attempts it.
 */
export function restoreLayoutFromSettings(p: Persisted) {
  replaceLayout(p.root, p.activePaneId);
}

let persistTimer: number | null = null;
let pendingDirty = false;
let persistInstalled = false;
let firstTickConsumed = false;

function flushPersist() {
  persistTimer = null;
  if (!pendingDirty) return;
  pendingDirty = false;
  // Stringify the live tree at flush time (after the debounce stilled).
  // Previously we stringified inside the reactive effect, which paid the
  // cost on every drag-frame; now it's once per burst.
  const payload: Persisted = {
    root: unwrap(panesState.root),
    activePaneId: activePaneId(),
  };
  let json: string;
  try {
    json = JSON.stringify(payload);
  } catch (e) {
    console.warn("panes layout: stringify failed, skipping persist", e);
    return;
  }
  void api.setSetting(SETTING_KEY, json).catch((e) => {
    console.warn("panes layout persist failed:", e);
  });
}

/** Install a reactive watcher: any layout mutation schedules a debounced
 *  write to the settings table. Idempotent - calling more than once is a
 *  no-op.
 *
 *  Performance contract: the effect MUST NOT do work proportional to tree
 *  size on every reactive frame, because splitter-drag triggers reactive
 *  updates at pointermove cadence (60 fps × pane-count). We:
 *   - Walk the tree once to register fine-grained Solid deps (O(panes +
 *     splits + tabs), bounded by MAX_PANES + tabs).
 *   - Defer the actual `JSON.stringify(unwrap(...))` to the debounce-tail
 *     `flushPersist`. During a drag burst we re-arm the timer hundreds of
 *     times but only stringify once at the end.
 *
 *  The previous implementation stringified inside the effect itself, which
 *  meant a drag burst over a 6-pane / 12-tab layout did 60 × deep
 *  serialisations per second of dragging. */
export function scheduleLayoutPersist() {
  if (persistInstalled) return;
  persistInstalled = true;

  // createRoot so the effect lives outside any component hierarchy and won't
  // be torn down with MainView.
  createRoot(() => {
    createEffect(() => {
      // Read for reactivity only - no allocation-heavy work here.
      void activePaneId();
      readDeep(panesState.root);
      if (!firstTickConsumed) {
        firstTickConsumed = true;
        return;
      }
      // Re-arm the debounce. Stringify happens in `flushPersist`.
      pendingDirty = true;
      if (persistTimer != null) clearTimeout(persistTimer);
      persistTimer = window.setTimeout(flushPersist, PERSIST_DEBOUNCE_MS);
    });
  });
}

/** Touch every property of the layout tree to register a Solid dependency
 *  on each. Cost is O(panes + splits + tabs), bounded by MAX_PANES * tabs. */
function readDeep(node: LayoutNode): void {
  if (node.kind === "pane") {
    void node.id;
    void node.activeTabIdx;
    for (const t of node.tabs) {
      void t.id;
      void t.noteId;
    }
    return;
  }
  void node.id;
  void node.direction;
  for (let i = 0; i < node.sizes.length; i++) void node.sizes[i];
  for (const c of node.children) readDeep(c);
}

/** Test/recovery utility: clear the saved layout. */
export async function clearPersistedLayout() {
  await api.setSetting(SETTING_KEY, "").catch(() => {});
}
