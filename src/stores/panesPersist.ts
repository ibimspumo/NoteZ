import { createEffect, createRoot } from "solid-js";
import { unwrap } from "solid-js/store";
import {
  type LayoutNode,
  type PaneId,
  migrateLegacyLayout,
  reconcileWithExistingNotes,
} from "../lib/paneTree";
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

/** Drop noteId references that are no longer valid. Used after `empty_trash`
 *  or any other bulk hard-delete that the layout could be referencing. */
export function pruneLayoutForValidNotes(validIds: Set<string>) {
  const next = reconcileWithExistingNotes(unwrap(panesState.root), validIds);
  if (next !== unwrap(panesState.root)) replaceLayout(next, activePaneId());
}

let persistTimer: number | null = null;
let pendingJson: string | null = null;
let persistInstalled = false;
let firstTickConsumed = false;

function flushPersist() {
  persistTimer = null;
  const json = pendingJson;
  pendingJson = null;
  if (!json) return;
  void api.setSetting(SETTING_KEY, json).catch((e) => {
    console.warn("panes layout persist failed:", e);
  });
}

/** Install a reactive watcher: any layout mutation schedules a debounced
 *  write to the settings table. Idempotent - calling more than once is a
 *  no-op.
 *
 *  We compute the full JSON inside the effect so Solid tracks every nested
 *  property as a dependency. With `reconcile`, deep mutations (e.g. dragging
 *  a divider, which only touches `sizes` inside one split node, or switching
 *  the active tab in a pane) don't fire the top-level `root` accessor;
 *  reading the full payload here makes those updates reach the persist
 *  scheduler. */
export function scheduleLayoutPersist() {
  if (persistInstalled) return;
  persistInstalled = true;

  // createRoot so the effect lives outside any component hierarchy and won't
  // be torn down with MainView.
  createRoot(() => {
    createEffect(() => {
      const payload: Persisted = {
        root: unwrap(panesState.root),
        activePaneId: activePaneId(),
      };
      // Walk the tree reactively to make every nested change a dep.
      // Doing this *separately* from unwrap above means unwrap returns a
      // plain (non-proxy) snapshot for serialization, while the explicit
      // reads below set up the dependency graph.
      readDeep(panesState.root);
      const json = JSON.stringify(payload);
      if (!firstTickConsumed) {
        firstTickConsumed = true;
        return;
      }
      pendingJson = json;
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
