import type { LexicalEditor } from "lexical";
import { batch, createMemo, createSignal } from "solid-js";
import { createStore, produce, unwrap } from "solid-js/store";
import {
  type LayoutNode,
  MIN_PANE_FRACTION,
  type PaneId,
  type Side,
  type SplitId,
  type Tab,
  type TabId,
  activeNoteId as activeNoteIdOf,
  activeTab as activeTabOf,
  collectLeaves,
  findPane,
  findTabByNoteId,
  newPane,
  newTab,
  normalize,
  paneCount,
  reconcileWithExistingNotes,
  removePane,
  splitTreeAt,
} from "../lib/paneTree";
import type { Note } from "../lib/types";
import type { SavingState } from "../views/useSavePipeline";

export type {
  LayoutNode,
  LeafPane,
  SplitNode,
  PaneId,
  Side,
  SplitId,
  Tab,
  TabId,
} from "../lib/paneTree";

/**
 * Imperative API a parent uses to coordinate cross-pane work that doesn't
 * fit naturally as props (flushing in-flight saves before navigation,
 * applying external updates that bypass the save pipeline, etc.). Lives in
 * the panes store so consumers can pull the active tab's API without
 * the per-tab content needing to push it back up the tree on every mount.
 *
 * Registered per-tab (not per-pane): each tab owns its own Lexical instance
 * and save pipeline. The active tab in the active pane is what global
 * consumers like the toolbar, save indicator, and snapshot dialog see.
 */
export type EditorPaneApi = {
  flushSave: () => Promise<void>;
  hasPendingSave: () => boolean;
  resetBaseline: (noteId: string, json: string) => void;
  reloadFromBackend: (noteId: string) => Promise<void>;
  applyExternalUpdate: (note: Note) => void;
  syncActiveNote: (note: Note) => void;
  savingState: () => SavingState;
};

/** Soft cap on panes. Beyond this, splits no-op with a toast. The cost per
 *  pane is the structural overhead (split tree, reactive memos, drop
 *  overlays); the editor instances themselves are now per-tab so the cap
 *  scales with concurrent splits rather than open notes. */
export const MAX_PANES = 8;

type PanesState = {
  root: LayoutNode;
  activePaneId: PaneId;
};

const initialPane = newPane(null);
const [state, setState] = createStore<PanesState>({
  root: initialPane,
  activePaneId: initialPane.id,
});

export const panesState = state;
export const activePaneId = () => state.activePaneId;

export const panes = createMemo(() => collectLeaves(state.root));
export const totalPaneCount = createMemo(() => paneCount(state.root));

/** Active tab of the active pane (or null if the pane couldn't be found,
 *  which shouldn't happen but is defensive). */
export const activeTab = createMemo<Tab | null>(() => {
  const pane = findPane(state.root, state.activePaneId);
  return pane ? activeTabOf(pane) : null;
});

export const activeTabId = createMemo<TabId | null>(() => {
  const t = activeTab();
  return t ? t.id : null;
});

export const activePaneNoteId = createMemo(() => {
  const pane = findPane(state.root, state.activePaneId);
  return pane ? activeNoteIdOf(pane) : null;
});

/** Set of all noteIds currently open across all tabs across all panes. The
 *  sidebar uses this for the "open in another pane" affordance. Returns a
 *  Set so membership tests stay O(1) per row. */
export const openNoteIds = createMemo(() => {
  const set = new Set<string>();
  for (const p of collectLeaves(state.root)) {
    for (const t of p.tabs) {
      if (t.noteId) set.add(t.noteId);
    }
  }
  return set;
});

export function setActivePaneId(id: PaneId) {
  if (id === state.activePaneId) return;
  setState("activePaneId", id);
}

/**
 * Tree-mutation helper.
 *
 * Critical detail: callers always compute `nextRoot` from `unwrap(state.root)`
 * rather than reading the live proxy directly. Solid's `setProperty` set-trap
 * unwraps values before storing, so a plain tree round-trips cleanly. The
 * tree ops preserve identity for unchanged subtrees, so a resize-drag (which
 * only mutates one split's `sizes`) keeps every other pane's reference - and
 * therefore every other tab's Lexical instance - stable. Without that, every
 * drag step would tear down and rebuild every editor.
 */
function commitRoot(nextRoot: LayoutNode) {
  // CRITICAL: use the object-form `setState({ root: ... })` rather than
  // the path-form `setState("root", ...)`. The path form goes through
  // Solid's `mergeStoreNode` which merges new properties INTO the
  // existing underlying object at that path. With our tree, that breaks
  // when the new tree shares references with the old underlying.
  setState({ root: nextRoot });
}

/** Walk the tree and run `mutator` on the matching leaf pane in-place via
 *  `produce`. Returns true if a mutation happened. Used for changes that don't
 *  rearrange topology (active tab idx, tab noteId, tab order within a pane) -
 *  these don't need a tree rebuild and identity-preserving in-place mutation
 *  keeps every other pane's Lexical instance stable. */
function mutatePane(
  paneId: PaneId,
  mutator: (p: { tabs: Tab[]; activeTabIdx: number }) => boolean,
) {
  let changed = false;
  setState(
    "root",
    produce((root: LayoutNode) => {
      const visit = (n: LayoutNode): boolean => {
        if (n.kind === "pane") {
          if (n.id !== paneId) return false;
          if (mutator(n)) changed = true;
          return true;
        }
        for (const c of n.children) {
          if (visit(c)) return true;
        }
        return false;
      };
      visit(root);
    }),
  );
  return changed;
}

/** Switch to a specific tab within a pane (by index). Also focuses the pane. */
export function setActiveTabIdx(paneId: PaneId, idx: number) {
  const pane = findPane(unwrap(state.root), paneId);
  if (!pane) return;
  if (idx < 0 || idx >= pane.tabs.length) return;
  batch(() => {
    if (pane.activeTabIdx !== idx) {
      mutatePane(paneId, (p) => {
        p.activeTabIdx = idx;
        return true;
      });
    }
    if (state.activePaneId !== paneId) setState("activePaneId", paneId);
  });
}

/** Switch to a tab by its id within a pane. */
export function setActiveTabId(paneId: PaneId, tabId: TabId) {
  const pane = findPane(unwrap(state.root), paneId);
  if (!pane) return;
  const idx = pane.tabs.findIndex((t) => t.id === tabId);
  if (idx >= 0) setActiveTabIdx(paneId, idx);
}

/**
 * Open a note in the active tab of the given pane. If the note is already
 * open anywhere (in another pane, or in another tab of this pane), the
 * existing tab is focused instead - the global same-note guard keeps each
 * note in exactly one tab so the save pipelines can't race on the same id.
 *
 * Pass `null` to clear the active tab (e.g. when the underlying note was
 * deleted).
 */
export function openNoteInPane(
  paneId: PaneId,
  noteId: string | null,
): { reusedTabId: TabId | null; reusedPaneId: PaneId | null } {
  if (noteId === null) {
    mutatePane(paneId, (p) => {
      const t = p.tabs[p.activeTabIdx];
      if (t.noteId === null) return false;
      t.noteId = null;
      return true;
    });
    setState("activePaneId", paneId);
    return { reusedTabId: null, reusedPaneId: null };
  }
  const existing = findTabByNoteId(unwrap(state.root), noteId);
  if (existing) {
    const targetTabId = existing.pane.tabs[existing.tabIdx].id;
    setActiveTabIdx(existing.pane.id, existing.tabIdx);
    return { reusedTabId: targetTabId, reusedPaneId: existing.pane.id };
  }
  mutatePane(paneId, (p) => {
    const t = p.tabs[p.activeTabIdx];
    if (t.noteId === noteId) return false;
    t.noteId = noteId;
    return true;
  });
  setState("activePaneId", paneId);
  return { reusedTabId: null, reusedPaneId: null };
}

/** Convenience: open a note in the active pane (semantics of
 *  `openNoteInPane(activePaneId, noteId)`). Used by the sidebar and command bar. */
export function openNoteInActivePane(noteId: string | null): {
  reusedTabId: TabId | null;
  reusedPaneId: PaneId | null;
} {
  return openNoteInPane(state.activePaneId, noteId);
}

/**
 * Add a new tab to a pane and focus it. Same-note guard: if the noteId is
 * already open anywhere, focus that tab instead. Pass `noteId: null` for an
 * empty new tab (Cmd+T case).
 *
 * If the active tab of `paneId` is empty (noteId === null) and we'd be
 * opening a real note, we *replace* the empty tab rather than adding a new
 * one. Browsers do the same: opening a link in a blank "New Tab" doesn't
 * leave a phantom empty tab behind.
 */
export function openNoteInNewTab(
  paneId: PaneId,
  noteId: string | null,
): { newTabId: TabId | null; reusedTabId: TabId | null; reusedPaneId: PaneId | null } {
  if (noteId !== null) {
    const existing = findTabByNoteId(unwrap(state.root), noteId);
    if (existing) {
      const targetTabId = existing.pane.tabs[existing.tabIdx].id;
      setActiveTabIdx(existing.pane.id, existing.tabIdx);
      return { newTabId: null, reusedTabId: targetTabId, reusedPaneId: existing.pane.id };
    }
  }
  const pane = findPane(unwrap(state.root), paneId);
  if (!pane) return { newTabId: null, reusedTabId: null, reusedPaneId: null };
  // Replace-the-empty-tab heuristic.
  const activeT = pane.tabs[pane.activeTabIdx];
  if (noteId !== null && activeT && activeT.noteId === null) {
    const tabId = activeT.id;
    mutatePane(paneId, (p) => {
      p.tabs[p.activeTabIdx].noteId = noteId;
      return true;
    });
    setState("activePaneId", paneId);
    return { newTabId: tabId, reusedTabId: null, reusedPaneId: null };
  }
  const tab = newTab(noteId);
  mutatePane(paneId, (p) => {
    p.tabs.splice(p.activeTabIdx + 1, 0, tab);
    p.activeTabIdx = p.activeTabIdx + 1;
    return true;
  });
  setState("activePaneId", paneId);
  return { newTabId: tab.id, reusedTabId: null, reusedPaneId: null };
}

/** Convenience: add an empty (noteId=null) tab to the active pane and focus it.
 *  Used by Cmd+T. */
export function openEmptyTabInActivePane(): TabId | null {
  return openNoteInNewTab(state.activePaneId, null).newTabId;
}

/**
 * Close a tab by id in a pane.
 *
 * If this was the last tab in the pane:
 * - and the pane is the only pane in the layout → clear to a single empty
 *   tab (the layout must always have at least one pane with one tab)
 * - otherwise → remove the entire pane from the tree
 *
 * If this was the active tab and there are other tabs → focus the next tab
 * (right of the closed one, or the new last tab if we closed the rightmost).
 */
export function closeTab(paneId: PaneId, tabId: TabId) {
  const pane = findPane(unwrap(state.root), paneId);
  if (!pane) return;
  const idx = pane.tabs.findIndex((t) => t.id === tabId);
  if (idx < 0) return;

  // Last tab in pane → either clear to empty or remove the pane.
  if (pane.tabs.length === 1) {
    const total = totalPaneCount();
    if (total <= 1) {
      // Single-pane: replace the tab's contents with a fresh empty tab so the
      // empty picker shows up.
      mutatePane(paneId, (p) => {
        p.tabs = [newTab(null)];
        p.activeTabIdx = 0;
        return true;
      });
      return;
    }
    closePane(paneId);
    return;
  }

  // Multi-tab: splice the tab out.
  mutatePane(paneId, (p) => {
    p.tabs.splice(idx, 1);
    if (p.activeTabIdx === idx) {
      // Active tab was closed; pick the next one (or the new last if we were
      // already at the end).
      p.activeTabIdx = Math.min(idx, p.tabs.length - 1);
    } else if (p.activeTabIdx > idx) {
      // Active was to the right of the closed tab; shift left to keep pointing
      // at the same tab.
      p.activeTabIdx -= 1;
    }
    return true;
  });
}

/** Close the active tab of a pane. Mirrors `closeTab(paneId, activeTabId)`. */
export function closeActiveTab(paneId: PaneId) {
  const pane = findPane(unwrap(state.root), paneId);
  if (!pane) return;
  const t = pane.tabs[pane.activeTabIdx];
  if (t) closeTab(paneId, t.id);
}

/** Reorder a tab within its pane (drag-to-reorder). Indices are post-removal:
 *  `moveTab(p, 0, 2)` moves the first tab to position 2 in the resulting array. */
export function moveTab(paneId: PaneId, fromIdx: number, toIdx: number) {
  if (fromIdx === toIdx) return;
  mutatePane(paneId, (p) => {
    if (fromIdx < 0 || fromIdx >= p.tabs.length) return false;
    const clamped = Math.max(0, Math.min(p.tabs.length - 1, toIdx));
    if (fromIdx === clamped) return false;
    const activeTabId = p.tabs[p.activeTabIdx].id;
    const [moved] = p.tabs.splice(fromIdx, 1);
    p.tabs.splice(clamped, 0, moved);
    p.activeTabIdx = p.tabs.findIndex((t) => t.id === activeTabId);
    return true;
  });
}

/** Same-note-aware split. Returns the new pane's id, or null if the cap is
 *  reached or the note is already open elsewhere (in which case the existing
 *  tab is focused instead). */
export function splitPane(
  targetPaneId: PaneId,
  side: Side,
  noteId: string | null,
): { newPaneId: PaneId | null; reusedPaneId: PaneId | null } {
  if (totalPaneCount() >= MAX_PANES) {
    return { newPaneId: null, reusedPaneId: null };
  }
  const root = unwrap(state.root);
  if (noteId) {
    const existing = findTabByNoteId(root, noteId);
    if (existing) {
      setActiveTabIdx(existing.pane.id, existing.tabIdx);
      return { newPaneId: null, reusedPaneId: existing.pane.id };
    }
  }
  const inserted = newPane(noteId);
  const next = splitTreeAt(root, targetPaneId, side, inserted);
  if (next === root) {
    return { newPaneId: null, reusedPaneId: null };
  }
  const normalized = normalize(next);
  batch(() => {
    commitRoot(normalized);
    setState("activePaneId", inserted.id);
  });
  return { newPaneId: inserted.id, reusedPaneId: null };
}

/** Remove an entire pane from the tree (all its tabs disappear). On the last
 *  remaining pane: clear all tabs to a single empty tab instead of deleting. */
export function closePane(paneId: PaneId) {
  const total = totalPaneCount();
  const root = unwrap(state.root);
  if (total <= 1) {
    mutatePane(paneId, (p) => {
      p.tabs = [newTab(null)];
      p.activeTabIdx = 0;
      return true;
    });
    return;
  }
  const removed = removePane(root, paneId);
  if (!removed) return;
  const next = normalize(removed);
  batch(() => {
    commitRoot(next);
    if (state.activePaneId === paneId) {
      const remaining = collectLeaves(next);
      if (remaining[0]) setState("activePaneId", remaining[0].id);
    }
  });
}

/**
 * Adjust a split's boundary in place, preserving every other object's identity
 * in the tree. Mutates `sizes` through `produce` so children arrays stay
 * referentially stable - the only thing Solid notifies is the cell-style
 * consumer reading `sizes[i]`.
 */
export function setBoundary(splitId: SplitId, boundaryIdx: number, leftFraction: number) {
  setState(
    "root",
    produce((root: LayoutNode) => {
      const visit = (n: LayoutNode): boolean => {
        if (n.kind === "pane") return false;
        if (n.id === splitId) {
          if (boundaryIdx < 0 || boundaryIdx >= n.children.length - 1) return true;
          const total = n.sizes[boundaryIdx] + n.sizes[boundaryIdx + 1];
          const minLeft = Math.min(MIN_PANE_FRACTION, total / 2);
          const maxLeft = total - minLeft;
          const newLeftAbs = Math.max(minLeft, Math.min(maxLeft, leftFraction * total));
          n.sizes[boundaryIdx] = newLeftAbs;
          n.sizes[boundaryIdx + 1] = total - newLeftAbs;
          return true;
        }
        for (const c of n.children) {
          if (visit(c)) return true;
        }
        return false;
      };
      visit(root);
    }),
  );
}

/** Replace the entire tree (used at restore-from-disk). The new tree is
 *  normalized and an active pane is picked. */
export function replaceLayout(root: LayoutNode, activeId?: PaneId) {
  const normalized = normalize(root);
  const leaves = collectLeaves(normalized);
  if (leaves.length === 0) {
    // Defensive: empty tree shouldn't happen, but reset to a single empty pane.
    const fallback = newPane(null);
    batch(() => {
      commitRoot(fallback);
      setState("activePaneId", fallback.id);
    });
    return;
  }
  const nextActive = activeId && leaves.some((l) => l.id === activeId) ? activeId : leaves[0].id;
  batch(() => {
    commitRoot(normalized);
    setState("activePaneId", nextActive);
  });
}

/** Drop noteId references that no longer exist (purged notes). Tabs survive
 *  but their noteId becomes null - so the empty picker takes over. */
export function reconcileLayoutWithNotes(validIds: Set<string>) {
  const root = unwrap(state.root);
  const next = reconcileWithExistingNotes(root, validIds);
  if (next !== root) commitRoot(next);
}

/** Find the pane currently showing a given noteId (in any tab), if any. */
export function paneForNote(noteId: string): PaneId | null {
  const f = findTabByNoteId(unwrap(state.root), noteId);
  return f?.pane.id ?? null;
}

/* ---------- Editor / API registries ---------- */

// Per-tab editor handles and imperative APIs. Keyed by tabId because each tab
// owns its own Lexical instance and save pipeline. We use plain Maps + a
// version signal rather than a Solid store because the values are
// non-serializable (LexicalEditor instance, function-bag API).
const editors = new Map<TabId, LexicalEditor>();
const apis = new Map<TabId, EditorPaneApi>();
const [registryVersion, bumpRegistry] = createSignal(0);

export function registerTabEditor(tabId: TabId, editor: LexicalEditor | null) {
  if (editor) editors.set(tabId, editor);
  else editors.delete(tabId);
  bumpRegistry((v) => v + 1);
}

export function registerTabApi(tabId: TabId, api: EditorPaneApi | null) {
  if (api) apis.set(tabId, api);
  else apis.delete(tabId);
  bumpRegistry((v) => v + 1);
}

export const activeEditor = createMemo<LexicalEditor | null>(() => {
  registryVersion();
  const id = activeTabId();
  return id ? (editors.get(id) ?? null) : null;
});

export const activeApi = createMemo<EditorPaneApi | null>(() => {
  registryVersion();
  const id = activeTabId();
  return id ? (apis.get(id) ?? null) : null;
});

export function getTabApi(tabId: TabId): EditorPaneApi | null {
  registryVersion();
  return apis.get(tabId) ?? null;
}

/** Iterate all live tab APIs across all panes. Used to flush every editor's
 *  pending save (e.g. when emptying trash or other bulk ops). */
export function allTabApis(): EditorPaneApi[] {
  registryVersion();
  return [...apis.values()];
}

/* ---------- Drag-and-drop signal ---------- */

// Active-drag state. Set when the sidebar starts a note drag, cleared on
// dragend/drop. Used by EditorPane to decide whether to render its drop
// overlay - keeps DOM cost zero when nothing is being dragged.
const [draggedNoteId, setDraggedNoteId] = createSignal<string | null>(null);
export const dragNoteId = draggedNoteId;
export function startNoteDrag(noteId: string) {
  setDraggedNoteId(noteId);
}
export function endNoteDrag() {
  setDraggedNoteId(null);
}
