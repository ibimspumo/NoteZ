import { createMemo, createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { api } from "../lib/tauri";
import type { DeleteFolderMode, Folder, FolderFilter } from "../lib/types";

// Setting keys mirroring `src-tauri/src/constants.rs`. Kept inline here so a
// typo in the key surfaces at the boundary (the backend's allowlist will
// reject anything not in `KNOWN_SETTING_KEYS`).
const KEY_ACTIVE_FILTER = "folders:active_filter";
const KEY_EXPANDED = "folders:expanded";
const KEY_SECTION_OPEN = "folders:section_open";

/**
 * Folders store. Folders are loaded once on boot (the count is bounded by
 * user behaviour - hundreds at most, never the millions-budget that drives
 * the notes pagination), and mutated in-place from each action's response.
 *
 * The store keeps the flat list returned by the backend; consumers build
 * the visible tree via `folderTree` (memoized).
 */
type FoldersState = {
  list: Folder[];
  loaded: boolean;
};

const [state, setState] = createStore<FoldersState>({
  list: [],
  loaded: false,
});

export const foldersState = state;

/** Persisted active filter. The notes store reads this and passes it to
 *  `list_notes` on every refresh / first page. Persisted to the settings
 *  table so the sidebar reopens scoped to the same folder. */
const [activeFilter, setActiveFilter] = createSignal<FolderFilter>({ kind: "all" });
export const activeFolderFilter = activeFilter;
export function setActiveFolderFilter(filter: FolderFilter) {
  setActiveFilter(filter);
  void persist(KEY_ACTIVE_FILTER, JSON.stringify(filter));
}

/** Set the active filter without persisting - used when restoring from
 *  settings on boot, so the load doesn't echo back as a write. */
function setActiveFolderFilterSilent(filter: FolderFilter) {
  setActiveFilter(filter);
}

/** Which sub-tree branches are open in the sidebar tree. Folder ids only.
 *  Persisted so the user reopens to the same expanded state. */
const [expanded, setExpanded] = createSignal<Set<string>>(new Set());
export const expandedFolders = expanded;
export function toggleFolderExpanded(id: string) {
  let nextSet: Set<string> | null = null;
  setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    nextSet = next;
    return next;
  });
  if (nextSet) void persist(KEY_EXPANDED, JSON.stringify([...nextSet]));
}

/** Whether the folders section in the sidebar is open at all. Persisted. */
const [foldersOpen, setFoldersOpenSignal] = createSignal(false);
export const foldersSectionOpen = foldersOpen;
export function setFoldersSectionOpen(open: boolean) {
  setFoldersOpenSignal(open);
  void persist(KEY_SECTION_OPEN, open ? "1" : "0");
}

/** Folder id whose row should auto-enter rename mode on next render. Used
 *  to give a freshly-created folder the Finder-style "click + and start
 *  typing" feel without relying on `window.prompt`, which doesn't work
 *  reliably in Tauri's WKWebView. The row clears it on consumption. */
const [pendingRename, setPendingRenameSignal] = createSignal<string | null>(null);
export const pendingRenameFolderId = pendingRename;
export function consumePendingRename(id: string): boolean {
  if (pendingRename() !== id) return false;
  setPendingRenameSignal(null);
  return true;
}
export function setPendingRename(id: string | null) {
  setPendingRenameSignal(id);
}

async function persist(key: string, value: string) {
  try {
    await api.setSetting(key, value);
  } catch (e) {
    // Persistence is best-effort. A failure here means the next launch
    // falls back to defaults, which is harmless.
    console.warn(`persist ${key} failed:`, e);
  }
}

/** Hydrate folder UI state from settings. Call AFTER `refreshFolders()` so
 *  a persisted folder-id filter pointing at a since-deleted folder falls
 *  back to "All Notes" rather than scoping the list to nothing. */
export async function loadFolderPrefs() {
  try {
    const [filterRaw, expandedRaw, sectionRaw] = await Promise.all([
      api.getSetting(KEY_ACTIVE_FILTER),
      api.getSetting(KEY_EXPANDED),
      api.getSetting(KEY_SECTION_OPEN),
    ]);
    if (filterRaw) {
      const parsed = parseFilter(filterRaw);
      if (parsed) {
        // If the persisted filter points at a folder that no longer
        // exists (deleted while the app was closed), fall back to All.
        if (parsed.kind === "folder" && !state.list.some((f) => f.id === parsed.id)) {
          setActiveFolderFilterSilent({ kind: "all" });
        } else {
          setActiveFolderFilterSilent(parsed);
        }
      }
    }
    if (expandedRaw) {
      try {
        const arr = JSON.parse(expandedRaw);
        if (Array.isArray(arr)) {
          // Drop ids that no longer exist so the persisted set doesn't
          // grow unboundedly across folder lifetimes.
          const live = new Set(state.list.map((f) => f.id));
          setExpanded(
            new Set(arr.filter((x): x is string => typeof x === "string" && live.has(x))),
          );
        }
      } catch {
        // Ignore - corrupt JSON falls through to default empty set.
      }
    }
    if (sectionRaw === "1") setFoldersOpenSignal(true);
  } catch (e) {
    console.warn("loadFolderPrefs failed:", e);
  }
}

function parseFilter(raw: string): FolderFilter | null {
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== "object") return null;
    if (v.kind === "all" || v.kind === "inbox") return { kind: v.kind };
    if (v.kind === "folder" && typeof v.id === "string") {
      return {
        kind: "folder",
        id: v.id,
        include_descendants: v.include_descendants !== false,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export type FolderTreeNode = {
  folder: Folder;
  children: FolderTreeNode[];
  /** Sum of `folder.note_count` over this node and all descendants. Computed
   *  once per tree rebuild so the sidebar can render the rollup count without
   *  walking children at render time. */
  rollupNoteCount: number;
};

/** Build a tree from the flat list. Re-runs only when the list changes. */
export const folderTree = createMemo<FolderTreeNode[]>(() => {
  const flat = state.list;
  if (flat.length === 0) return [];

  const byParent = new Map<string | null, Folder[]>();
  for (const f of flat) {
    const key = f.parent_id;
    const arr = byParent.get(key);
    if (arr) arr.push(f);
    else byParent.set(key, [f]);
  }

  const buildChildren = (parentId: string | null): FolderTreeNode[] => {
    const kids = byParent.get(parentId);
    if (!kids) return [];
    return kids.map((folder) => {
      const children = buildChildren(folder.id);
      const rollup = children.reduce((sum, c) => sum + c.rollupNoteCount, folder.note_count);
      return { folder, children, rollupNoteCount: rollup };
    });
  };

  return buildChildren(null);
});

/** Look up a folder by id. */
export function findFolder(id: string): Folder | undefined {
  return state.list.find((f) => f.id === id);
}

export async function refreshFolders() {
  const list = await api.listFolders();
  setState({ list, loaded: true });
}

export async function createFolder(name: string, parentId?: string | null): Promise<Folder> {
  const folder = await api.createFolder(name, parentId ?? null);
  setState(
    produce((s) => {
      s.list.push(folder);
    }),
  );
  // Auto-open the section so a freshly created folder is actually visible
  // (otherwise the user only sees the section header counter advance).
  if (!foldersOpen()) {
    setFoldersSectionOpen(true);
  }
  // Auto-expand the parent so the new folder is visible.
  if (parentId) {
    setExpanded((prev) => {
      if (prev.has(parentId)) return prev;
      const next = new Set(prev);
      next.add(parentId);
      return next;
    });
  }
  return folder;
}

export async function renameFolder(id: string, name: string): Promise<Folder> {
  const folder = await api.renameFolder(id, name);
  setState(
    produce((s) => {
      const idx = s.list.findIndex((f) => f.id === id);
      if (idx >= 0) s.list[idx] = folder;
    }),
  );
  return folder;
}

/** Delete a folder. The optional `mode` decides what happens to the
 *  folder's contents (see `DeleteFolderMode`). Defaults to reparenting
 *  to the parent folder so a `deleteFolder(id)` call with no mode behaves
 *  like before this UX iteration. */
export async function deleteFolder(id: string, mode?: DeleteFolderMode): Promise<void> {
  await api.deleteFolder(id, mode);
  // Mirror the backend mutation in the local store so the sidebar doesn't
  // wait on a refresh round-trip. The exact mirror differs per mode -
  // reparent variants only drop the deleted folder and rewire pointers,
  // whereas trash_notes wipes the whole subtree.
  const removed = state.list.find((f) => f.id === id);
  const kind = mode?.kind ?? "reparent_to_parent";
  const reparentTarget: string | null =
    kind === "reparent_to_parent"
      ? (removed?.parent_id ?? null)
      : kind === "reparent_to"
        ? ((mode as { kind: "reparent_to"; folder_id: string | null }).folder_id ?? null)
        : null;

  setState(
    produce((s) => {
      if (kind === "trash_notes") {
        // Collect the entire subtree rooted at `id` so we can drop the
        // matching rows from the local store. Walk via parent_id since the
        // store is flat.
        const doomed = new Set<string>([id]);
        let added = true;
        while (added) {
          added = false;
          for (const f of s.list) {
            if (f.parent_id && doomed.has(f.parent_id) && !doomed.has(f.id)) {
              doomed.add(f.id);
              added = true;
            }
          }
        }
        for (let i = s.list.length - 1; i >= 0; i--) {
          if (doomed.has(s.list[i].id)) s.list.splice(i, 1);
        }
        return;
      }
      // Reparent variants: rewire children, then drop the deleted row.
      for (const f of s.list) {
        if (f.parent_id === id) f.parent_id = reparentTarget;
      }
      const idx = s.list.findIndex((f) => f.id === id);
      if (idx >= 0) s.list.splice(idx, 1);
    }),
  );

  // If the active filter pointed at the deleted folder, fall back to All.
  const f = activeFilter();
  if (f.kind === "folder" && f.id === id) {
    setActiveFolderFilter({ kind: "all" });
  }
  // Drop from expanded set.
  setExpanded((prev) => {
    if (!prev.has(id)) return prev;
    const next = new Set(prev);
    next.delete(id);
    return next;
  });
}

/** Reparent a folder. Refuses moves that would create a cycle (the backend
 *  enforces this too, but checking client-side avoids a pointless IPC). */
export async function moveFolder(id: string, newParentId: string | null): Promise<void> {
  if (id === newParentId) return;
  if (newParentId && isAncestorOrSelf(id, newParentId)) {
    // Target is `id` itself or one of its descendants - cycle.
    return;
  }
  const updated = await api.moveFolder(id, newParentId);
  setState(
    produce((s) => {
      const idx = s.list.findIndex((f) => f.id === id);
      if (idx >= 0) s.list[idx] = updated;
    }),
  );
}

/** Adjust a folder's note_count by `delta` so the sidebar badge reflects a
 *  move/delete/restore without waiting for `refreshFolders()`. `null` is a
 *  no-op (Inbox has no folder row). */
export function bumpFolderNoteCount(folderId: string | null, delta: number) {
  if (!folderId || delta === 0) return;
  setState(
    produce((s) => {
      const target = s.list.find((f) => f.id === folderId);
      if (target) target.note_count = Math.max(0, target.note_count + delta);
    }),
  );
}

/** True if `maybeAncestor` is `of` itself or any of its ancestors in the
 *  current folder tree. Walks up via `parent_id`; bounded by tree depth. */
export function isAncestorOrSelf(maybeAncestor: string, of: string): boolean {
  let cur: string | null = of;
  // The 64 cap mirrors MAX_FOLDER_DEPTH on the Rust side - guards against a
  // corrupted cycle from looping forever.
  for (let i = 0; i < 64 && cur; i++) {
    if (cur === maybeAncestor) return true;
    const f = state.list.find((x) => x.id === cur);
    if (!f) return false;
    cur = f.parent_id;
  }
  return false;
}

/** True if a note with `folderId` should appear under the given filter. */
export function noteFitsFilter(folderId: string | null, filter: FolderFilter): boolean {
  if (filter.kind === "all") return true;
  if (filter.kind === "inbox") return folderId === null;
  if (folderId === null) return false;
  if (filter.include_descendants === false) return folderId === filter.id;
  return isAncestorOrSelf(filter.id, folderId);
}
