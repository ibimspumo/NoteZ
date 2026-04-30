import {
  type Component,
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import type { Folder } from "../../lib/types";
import {
  type FolderTreeNode,
  deleteFolder,
  folderTree,
  isAncestorOrSelf,
} from "../../stores/folders";
import { refreshNotes } from "../../stores/notes";

type Props = {
  /** Folder to delete. `null` keeps the dialog closed. The parent (FolderTree)
   *  controls visibility by setting/clearing this; the dialog itself just
   *  calls `onClose` when the user dismisses. */
  folder: Folder | null;
  onClose: () => void;
};

type Mode = "parent" | "pick" | "trash";

/**
 * Confirmation dialog for deleting a folder that has contents.
 *
 * Three destinations, all explicit so the user can't lose notes by reflex:
 *
 *  1. Move contents up to the parent folder (or Inbox if root) - the safe
 *     default, primary button.
 *  2. Move contents into a specific other folder - reveals an inline tree
 *     picker. Folders that would create a cycle (the deleted folder itself
 *     and its descendants) are excluded.
 *  3. Move all notes to Trash - the destructive option, marked danger.
 *     Soft-deletes recursively, drops the folder tree.
 *
 * Once an action is committed, the dialog calls `refreshNotes()` so the
 * sidebar list reflects the new tree topology + scope, then closes.
 */
export const DeleteFolderDialog: Component<Props> = (props) => {
  const [mode, setMode] = createSignal<Mode>("parent");
  const [pickedFolderId, setPickedFolderId] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);

  // Reset internal state every time the dialog opens for a different folder
  // so a previous run's "pick" selection doesn't leak.
  const folderId = () => props.folder?.id ?? null;
  let lastFolderId: string | null = null;
  createEffect(() => {
    const id = folderId();
    if (id !== lastFolderId) {
      lastFolderId = id;
      setMode("parent");
      setPickedFolderId(null);
      setBusy(false);
    }
  });

  // Total notes about to be affected (this folder + all descendants). The
  // tree node carries `rollupNoteCount` precomputed for us.
  const targetNode = createMemo<FolderTreeNode | null>(() => {
    const id = folderId();
    if (!id) return null;
    return findNode(folderTree(), id);
  });
  const noteCount = () => targetNode()?.rollupNoteCount ?? 0;

  // Subfolder count is informational - shown in the body so the user knows
  // the operation isn't just about the immediately-visible notes.
  const subfolderCount = () => {
    const node = targetNode();
    if (!node) return 0;
    let n = 0;
    const walk = (kids: FolderTreeNode[]) => {
      for (const k of kids) {
        n += 1;
        walk(k.children);
      }
    };
    walk(node.children);
    return n;
  };

  // Parent label for the primary "Move to parent" button. Root folders
  // surface "Inbox" because that's where their notes flow on reparent.
  const parentLabel = createMemo(() => {
    const f = props.folder;
    if (!f) return "Inbox";
    if (!f.parent_id) return "Inbox";
    return findNode(folderTree(), f.parent_id)?.folder.name ?? "Inbox";
  });

  // Pickable destinations: every folder except the one being deleted and
  // its descendants. "Inbox" is always available as a virtual option. Built
  // from the tree once per render of the picker.
  const pickableTree = createMemo<FolderTreeNode[]>(() => {
    const f = props.folder;
    if (!f) return folderTree();
    return prunedTree(folderTree(), f.id);
  });

  // Esc closes - matches every other dialog in the app.
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && props.folder && !busy()) {
      e.preventDefault();
      props.onClose();
    }
  };
  onMount(() => window.addEventListener("keydown", onKey));
  onCleanup(() => window.removeEventListener("keydown", onKey));

  const runDelete = async (modeKind: Mode) => {
    const f = props.folder;
    if (!f || busy()) return;
    setBusy(true);
    try {
      if (modeKind === "parent") {
        await deleteFolder(f.id, { kind: "reparent_to_parent" });
      } else if (modeKind === "pick") {
        await deleteFolder(f.id, {
          kind: "reparent_to",
          folder_id: pickedFolderId(),
        });
      } else {
        await deleteFolder(f.id, { kind: "trash_notes" });
      }
      // Reparent / trash both change the visible note set under the active
      // filter; refresh once so the list catches up without per-mode tracking.
      await refreshNotes();
      props.onClose();
    } catch (e) {
      console.warn("deleteFolder failed:", e);
      setBusy(false);
    }
  };

  const handlePrimary = () => void runDelete("parent");
  const handleTrash = () => void runDelete("trash");
  const handlePickConfirm = () => void runDelete("pick");

  return (
    <Show when={props.folder}>
      {(folder) => (
        <div
          class="nz-trash-backdrop"
          onClick={() => {
            if (!busy()) props.onClose();
          }}
        >
          <div
            class="nz-delete-folder-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="nz-delete-folder-title"
            onClick={(e) => e.stopPropagation()}
          >
            <header class="nz-delete-folder-header">
              <h2 class="nz-delete-folder-title" id="nz-delete-folder-title">
                Delete "{folder().name}"?
              </h2>
            </header>

            <p class="nz-delete-folder-blurb">
              <Show
                when={noteCount() > 0 || subfolderCount() > 0}
                fallback={<>This folder is empty. It will be removed.</>}
              >
                This folder contains{" "}
                <strong>
                  {noteCount()} {noteCount() === 1 ? "note" : "notes"}
                </strong>
                <Show when={subfolderCount() > 0}>
                  {" "}
                  across <strong>{subfolderCount()} subfolders</strong>
                </Show>
                . What should happen to them?
              </Show>
            </p>

            <Show
              when={noteCount() > 0 || subfolderCount() > 0}
              fallback={
                <footer class="nz-delete-folder-footer">
                  <button class="nz-pill-btn" onClick={() => props.onClose()} disabled={busy()}>
                    Cancel
                  </button>
                  <button class="nz-pill-btn danger" onClick={handlePrimary} disabled={busy()}>
                    Delete
                  </button>
                </footer>
              }
            >
              <div class="nz-delete-folder-options">
                <button
                  type="button"
                  class="nz-delete-folder-option"
                  classList={{ active: mode() === "parent" }}
                  disabled={busy()}
                  onClick={() => setMode("parent")}
                >
                  <span class="nz-delete-folder-option-title">
                    Move contents to {parentLabel()}
                  </span>
                  <span class="nz-delete-folder-option-sub">
                    Default - safe, nothing is deleted
                  </span>
                </button>

                <button
                  type="button"
                  class="nz-delete-folder-option"
                  classList={{ active: mode() === "pick" }}
                  disabled={busy()}
                  onClick={() => setMode("pick")}
                >
                  <span class="nz-delete-folder-option-title">
                    Move contents to a different folder…
                  </span>
                  <Show when={mode() === "pick"}>
                    <FolderPicker
                      tree={pickableTree()}
                      pickedId={pickedFolderId()}
                      onPick={(id) => setPickedFolderId(id)}
                    />
                  </Show>
                </button>

                <button
                  type="button"
                  class="nz-delete-folder-option danger"
                  classList={{ active: mode() === "trash" }}
                  disabled={busy()}
                  onClick={() => setMode("trash")}
                >
                  <span class="nz-delete-folder-option-title">Move all notes to Trash</span>
                  <span class="nz-delete-folder-option-sub">
                    Recoverable from Trash for 30 days
                  </span>
                </button>
              </div>

              <footer class="nz-delete-folder-footer">
                <button class="nz-pill-btn" onClick={() => props.onClose()} disabled={busy()}>
                  Cancel
                </button>
                <Show
                  when={mode() === "trash"}
                  fallback={
                    <Show
                      when={mode() === "pick"}
                      fallback={
                        <button
                          class="nz-pill-btn primary"
                          onClick={handlePrimary}
                          disabled={busy()}
                        >
                          Move &amp; delete folder
                        </button>
                      }
                    >
                      <button
                        class="nz-pill-btn primary"
                        onClick={handlePickConfirm}
                        disabled={busy()}
                      >
                        Move &amp; delete folder
                      </button>
                    </Show>
                  }
                >
                  <button class="nz-pill-btn danger" onClick={handleTrash} disabled={busy()}>
                    Move {noteCount()} to Trash
                  </button>
                </Show>
              </footer>
            </Show>
          </div>
        </div>
      )}
    </Show>
  );
};

const FolderPicker: Component<{
  tree: FolderTreeNode[];
  pickedId: string | null;
  onPick: (id: string | null) => void;
}> = (props) => {
  // Flatten the (already pruned) tree into rows with depth so the picker
  // can render with indentation. Bounded by user folder count.
  const rows = createMemo(() => flattenTree(props.tree));
  return (
    <div class="nz-folder-picker" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        class="nz-folder-picker-row"
        classList={{ active: props.pickedId === null }}
        onClick={() => props.onPick(null)}
      >
        <span class="nz-folder-row-spacer" />
        <span class="nz-folder-picker-label">📥 Inbox</span>
      </button>
      <For each={rows()}>
        {(row) => (
          <button
            type="button"
            class="nz-folder-picker-row"
            classList={{ active: props.pickedId === row.folder.id }}
            style={{ "--folder-depth": String(row.depth) }}
            onClick={() => props.onPick(row.folder.id)}
          >
            <span class="nz-folder-picker-label">{row.folder.name}</span>
          </button>
        )}
      </For>
    </div>
  );
};

function findNode(tree: FolderTreeNode[], id: string): FolderTreeNode | null {
  for (const n of tree) {
    if (n.folder.id === id) return n;
    const hit = findNode(n.children, id);
    if (hit) return hit;
  }
  return null;
}

/** Tree without `excludeRoot` and any of its descendants. Returns a fresh
 *  array structure - safe to use as a memo result. */
function prunedTree(tree: FolderTreeNode[], excludeRoot: string): FolderTreeNode[] {
  const out: FolderTreeNode[] = [];
  for (const n of tree) {
    if (isAncestorOrSelf(excludeRoot, n.folder.id)) continue;
    out.push({
      folder: n.folder,
      rollupNoteCount: n.rollupNoteCount,
      children: prunedTree(n.children, excludeRoot),
    });
  }
  return out;
}

function flattenTree(
  tree: FolderTreeNode[],
  depth = 0,
): Array<{ folder: FolderTreeNode["folder"]; depth: number }> {
  const out: Array<{ folder: FolderTreeNode["folder"]; depth: number }> = [];
  for (const n of tree) {
    out.push({ folder: n.folder, depth });
    out.push(...flattenTree(n.children, depth + 1));
  }
  return out;
}
