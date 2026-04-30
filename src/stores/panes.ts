import type { LexicalEditor } from "lexical";
import { batch, createMemo, createSignal } from "solid-js";
import { createStore, produce, unwrap } from "solid-js/store";
import {
  type LayoutNode,
  MIN_PANE_FRACTION,
  type PaneId,
  type Side,
  type SplitId,
  collectLeaves,
  findPane,
  findPaneByNoteId,
  newPane,
  normalize,
  paneCount,
  reconcileWithExistingNotes,
  removePane,
  splitTreeAt,
} from "../lib/paneTree";
import type { Note } from "../lib/types";
import type { SavingState } from "../views/useSavePipeline";

export type { LayoutNode, LeafPane, SplitNode, PaneId, Side, SplitId } from "../lib/paneTree";

/**
 * Imperative API a parent uses to coordinate cross-pane work that doesn't
 * fit naturally as props (flushing in-flight saves before navigation,
 * applying external updates that bypass the save pipeline, etc.). Lives in
 * the panes store so consumers can pull the active pane's API without
 * EditorPane needing to push it back up the tree on every mount.
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

/** Soft cap. Beyond this, splits no-op with a toast. The Lexical-instance and
 *  save-pipeline cost per pane is real (~200KB JS state, plus an FTS5 trip
 *  per save) so 8 is a generous-but-defensible ceiling for a desktop app. */
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

export const panes = createMemo(() => {
  console.log("[panes] memo:panes recomputing");
  return collectLeaves(state.root);
});
export const totalPaneCount = createMemo(() => {
  console.log("[panes] memo:totalPaneCount recomputing");
  return paneCount(state.root);
});

export const activePaneNoteId = createMemo(() => {
  console.log("[panes] memo:activePaneNoteId recomputing");
  const found = findPane(state.root, state.activePaneId);
  return found?.noteId ?? null;
});

/** Set of all noteIds currently open across all panes. The sidebar uses this
 *  to give a subtle "open in another pane" affordance to non-active rows.
 *  Returns a Set so membership tests stay O(1) per row. */
export const openNoteIds = createMemo(() => {
  console.log("[panes] memo:openNoteIds recomputing");
  const set = new Set<string>();
  for (const p of collectLeaves(state.root)) {
    if (p.noteId) set.add(p.noteId);
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
 * therefore every other `EditorPane`'s Lexical instance - stable. Without
 * that, every drag step would tear down and rebuild every editor.
 */
function commitRoot(nextRoot: LayoutNode) {
  // CRITICAL: use the object-form `setState({ root: ... })` rather than
  // the path-form `setState("root", ...)`. The path form goes through
  // Solid's `mergeStoreNode` which merges new properties INTO the
  // existing underlying object at that path. With our tree, that breaks
  // when the new tree shares references with the old underlying:
  //
  //   old underlying:  oldPane = {kind:"pane", id:"p1", noteId:"x"}
  //   new tree:        {kind:"split", children:[oldPane, newPane], ...}
  //
  // The merge mutates oldPane's properties to match the split, including
  // setting oldPane.children = [oldPane, newPane] - a self-reference.
  // Any read of `state.root.children[0].children[0]...` then recurses
  // until the stack overflows.
  //
  // The object-form does a direct property replacement at the panesState
  // level: `panesState.root = newTree`. The old pane object is never
  // mutated, just relocated in the tree.
  setState({ root: nextRoot });
}

/** In-place noteId mutation via `produce`. Critical: changing only a leaf's
 *  noteId is NOT a structural change, so we mutate through the store proxy
 *  rather than rebuilding the tree. If we replaced the leaf object (as
 *  `replacePaneNote` does), the pane-tree `<For>` - which keys by reference -
 *  would dispose the old `EditorPane` and mount a fresh one on every note
 *  switch. That tears down the Lexical instance and flashes the
 *  `EmptyPanePicker` for one frame before the new note loads. Mutating the
 *  field keeps every pane component (and its editor) alive across switches;
 *  Solid's proxy still notifies subscribers reading `props.noteId`. */
function setPaneNoteIdInPlace(paneId: PaneId, noteId: string | null): boolean {
  let changed = false;
  setState(
    "root",
    produce((root: LayoutNode) => {
      const visit = (n: LayoutNode): boolean => {
        if (n.kind === "pane") {
          if (n.id !== paneId) return false;
          if (n.noteId !== noteId) {
            n.noteId = noteId;
            changed = true;
          }
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

/** Set the noteId on a specific pane. If the note is already open in another
 *  pane, focus that pane instead and leave the layout alone (same-note guard).
 *  Pass `null` to clear a pane (e.g. when its note was deleted). */
export function openNoteInPane(
  paneId: PaneId,
  noteId: string | null,
): { reusedPaneId: PaneId | null } {
  if (noteId === null) {
    setPaneNoteIdInPlace(paneId, null);
    setState("activePaneId", paneId);
    return { reusedPaneId: null };
  }
  const existing = findPaneByNoteId(unwrap(state.root), noteId);
  if (existing && existing.id !== paneId) {
    setState("activePaneId", existing.id);
    return { reusedPaneId: existing.id };
  }
  setPaneNoteIdInPlace(paneId, noteId);
  setState("activePaneId", paneId);
  return { reusedPaneId: null };
}

/** Same-note-aware split. Returns the new pane's id, or null if the cap is
 *  reached or the note is already open elsewhere (in which case the existing
 *  pane is focused instead). */
export function splitPane(
  targetPaneId: PaneId,
  side: Side,
  noteId: string | null,
): { newPaneId: PaneId | null; reusedPaneId: PaneId | null } {
  console.log("[panes] splitPane: called", { targetPaneId, side, noteId });
  if (totalPaneCount() >= MAX_PANES) {
    console.log("[panes] splitPane: cap reached");
    return { newPaneId: null, reusedPaneId: null };
  }
  const root = unwrap(state.root);
  console.log("[panes] splitPane: root before", JSON.stringify(root));
  if (noteId) {
    const existing = findPaneByNoteId(root, noteId);
    if (existing) {
      console.log("[panes] splitPane: same-note guard, focusing", existing.id);
      setState("activePaneId", existing.id);
      return { newPaneId: null, reusedPaneId: existing.id };
    }
  }
  const inserted = newPane(noteId);
  const next = splitTreeAt(root, targetPaneId, side, inserted);
  console.log("[panes] splitPane: tree after splitTreeAt", JSON.stringify(next));
  if (next === root) {
    console.log("[panes] splitPane: tree unchanged, no-op");
    return { newPaneId: null, reusedPaneId: null };
  }
  const normalized = normalize(next);
  console.log("[panes] splitPane: about to commit", JSON.stringify(normalized));
  batch(() => {
    console.log("[panes] splitPane: inside batch, calling commitRoot");
    commitRoot(normalized);
    console.log("[panes] splitPane: commitRoot done, setting activePaneId");
    setState("activePaneId", inserted.id);
    console.log("[panes] splitPane: setState activePaneId done");
  });
  console.log("[panes] splitPane: batch returned, success");
  return { newPaneId: inserted.id, reusedPaneId: null };
}

export function closePane(paneId: PaneId) {
  const total = totalPaneCount();
  const root = unwrap(state.root);
  if (total <= 1) {
    // Last pane: clear it instead of removing - the tree must always have one.
    setPaneNoteIdInPlace(paneId, null);
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

/** Convenience: open a note in whichever pane is currently active. */
export function openNoteInActivePane(noteId: string | null): { reusedPaneId: PaneId | null } {
  return openNoteInPane(state.activePaneId, noteId);
}

/**
 * Adjust a split's boundary in place, preserving every other object's identity
 * in the tree. Critical: the previous implementation rebuilt the tree
 * immutably via `resizeBoundary`, which forced every ancestor up to the root
 * to take a new reference. With Solid's `<For>` keying child slots by item
 * identity, that disposed and re-created the subtree containing the splitter
 * element the user was actively dragging - `setPointerCapture` was bound to
 * an element that no longer existed, the next pointermove had no target, and
 * the drag silently aborted on the first reactive tick (instant "release"
 * after grab). Mutating `sizes` through `produce` keeps every node and the
 * `children` arrays referentially stable, so the only thing Solid notifies
 * is the cell-style consumer reading `sizes[i]`.
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

/** Drop noteId references that no longer exist (purged notes). */
export function reconcileLayoutWithNotes(validIds: Set<string>) {
  const root = unwrap(state.root);
  const next = reconcileWithExistingNotes(root, validIds);
  if (next !== root) commitRoot(next);
}

/** Find the pane currently showing a given noteId, if any. */
export function paneForNote(noteId: string): PaneId | null {
  const f = findPaneByNoteId(unwrap(state.root), noteId);
  return f?.id ?? null;
}

/* ---------- Editor / API registries ---------- */

// Per-pane editor handles and imperative APIs. We use plain Maps + a version
// signal rather than a Solid store because the values are non-serializable
// (LexicalEditor instance, function-bag API) and we only ever read them by
// active-pane id - no fine-grained subscription per pane needed.
const editors = new Map<PaneId, LexicalEditor>();
const apis = new Map<PaneId, EditorPaneApi>();
const [registryVersion, bumpRegistry] = createSignal(0);

export function registerPaneEditor(paneId: PaneId, editor: LexicalEditor | null) {
  if (editor) editors.set(paneId, editor);
  else editors.delete(paneId);
  bumpRegistry((v) => v + 1);
}

export function registerPaneApi(paneId: PaneId, api: EditorPaneApi | null) {
  if (api) apis.set(paneId, api);
  else apis.delete(paneId);
  bumpRegistry((v) => v + 1);
}

export const activeEditor = createMemo<LexicalEditor | null>(() => {
  registryVersion();
  return editors.get(state.activePaneId) ?? null;
});

export const activeApi = createMemo<EditorPaneApi | null>(() => {
  registryVersion();
  return apis.get(state.activePaneId) ?? null;
});

export function getPaneApi(paneId: PaneId): EditorPaneApi | null {
  registryVersion();
  return apis.get(paneId) ?? null;
}

/** Iterate all live pane APIs - used to flush every pane's pending save
 *  (e.g. when emptying trash or other bulk ops). */
export function allPaneApis(): EditorPaneApi[] {
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
  console.log("[dnd] startNoteDrag", noteId);
  setDraggedNoteId(noteId);
}
export function endNoteDrag() {
  console.log("[dnd] endNoteDrag");
  setDraggedNoteId(null);
}
