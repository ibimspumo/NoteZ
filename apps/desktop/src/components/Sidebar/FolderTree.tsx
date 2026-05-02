import { type Component, For, Show, createEffect, createSignal, onMount } from "solid-js";
import type { Folder } from "../../lib/types";
import {
  type FolderTreeNode,
  activeFolderFilter,
  consumePendingRename,
  createFolder,
  expandedFolders,
  folderTree,
  foldersSectionOpen,
  foldersState,
  isAncestorOrSelf,
  moveFolder,
  pendingRenameFolderId,
  renameFolder,
  setFoldersSectionOpen,
  setPendingRename,
  toggleFolderExpanded,
} from "../../stores/folders";
import { applyFolderFilter, moveNoteToFolder, refreshNotes } from "../../stores/notes";
import { dragNoteId } from "../../stores/panes";
import { ChevronRightIcon, FolderIcon, PlusIcon } from "../icons";
import { IconButton } from "../ui";
import { DeleteFolderDialog } from "./DeleteFolderDialog";

/** MIME type used to advertise a folder drag through the native DnD pipeline.
 *  Mirrors the note flag (`application/x-notez-note-id`) so a single dragover
 *  handler can sniff for either kind. */
const FOLDER_MIME = "application/x-notez-folder-id";
const NOTE_MIME = "application/x-notez-note-id";

/** Folder-drag signal. Mirrors `dragNoteId` from the panes store but for
 *  folder reparenting drags. Used to gate visual feedback on drop targets
 *  without inspecting `dataTransfer.types` on every hover frame. */
const [draggedFolderId, setDraggedFolderIdSignal] = createSignal<string | null>(null);
function startFolderDrag(id: string) {
  setDraggedFolderIdSignal(id);
}
function endFolderDrag() {
  setDraggedFolderIdSignal(null);
}

/** Module-level signal for the delete-confirmation dialog. Set by
 *  FolderRow's context menu, consumed by FolderTree which renders the
 *  dialog. Lifting the signal out of component scope avoids piping a
 *  callback through every nested FolderRow. */
const [pendingDelete, setPendingDeleteSignal] = createSignal<Folder | null>(null);

type Props = Record<string, never>;

/**
 * Folder tree section. Sits above Pinned in the sidebar.
 *
 * Layout strategy:
 *   - When collapsed (default), shows a single "filter row" with the current
 *     scope name (All Notes / Inbox / folder name) and a chevron.
 *   - When expanded, the chevron rotates and the tree drops down beneath -
 *     "All Notes" and "Inbox" as virtual roots, then the user's folders.
 *
 * The tree itself isn't virtualized: folder counts are bounded by user
 * behaviour (hundreds at most) and each row is cheap. If a future user
 * pushes this we can swap in a MeasuredVirtualList without touching the
 * data layer.
 */
export const FolderTree: Component<Props> = (_props) => {
  const open = foldersSectionOpen;
  const filter = activeFolderFilter;

  const activeLabel = () => {
    const f = filter();
    if (f.kind === "all") return "All Notes";
    if (f.kind === "inbox") return "Inbox";
    const folder = foldersState.list.find((x) => x.id === f.id);
    return folder?.name ?? "Folder";
  };

  // When the section is open the active row is highlighted in the tree
  // below - mirroring its name in the bar would just repeat what's already
  // visible (and looked confusing for users with a folder named the same
  // as the active filter). When closed, the bar is the only signal of the
  // current scope so we surface the actual filter name.
  const barLabel = () => (open() ? "Folders" : activeLabel());

  const handleCreate = async () => {
    // Finder-style: create with a default name, immediately drop the row
    // into rename mode. window.prompt() doesn't fire in Tauri's WKWebView
    // (no JS text input panel delegate), so the inline edit is the only
    // path that works.
    try {
      const folder = await createFolder("New folder", null);
      setPendingRename(folder.id);
    } catch (e) {
      console.warn("createFolder failed:", e);
    }
  };

  return (
    <div class="nz-folders" classList={{ open: open() }}>
      <div class="nz-folders-bar">
        <button
          type="button"
          class="nz-folders-toggle"
          aria-expanded={open()}
          onClick={() => setFoldersSectionOpen(!open())}
          title={open() ? "Hide folders" : "Show folders"}
        >
          <span class="nz-folders-chevron" classList={{ open: open() }}>
            <ChevronRightIcon width="10" height="10" />
          </span>
          <span class="nz-folders-label">{barLabel()}</span>
        </button>
        <Show when={open()}>
          <IconButton size="sm" aria-label="New folder" title="New folder" onClick={handleCreate}>
            <PlusIcon width="11" height="11" />
          </IconButton>
        </Show>
      </div>

      <Show when={open()}>
        <div
          class="nz-folders-tree"
          role="tree"
          onDragOver={(e) => {
            // Accept folder drags onto the tree background to reparent the
            // dragged folder to root (parent_id = null). Note drags fall
            // through - the user already has Inbox as a dedicated target.
            if (!draggedFolderId() && !e.dataTransfer?.types.includes(FOLDER_MIME)) return;
            e.preventDefault();
            if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
          }}
          onDrop={(e) => {
            const folderId = e.dataTransfer?.getData(FOLDER_MIME) || draggedFolderId();
            if (!folderId) return;
            // If a child row already handled this drop, its stopPropagation
            // means we never run; reaching here means the user dropped on
            // the gap between rows.
            e.preventDefault();
            void moveFolder(folderId, null).then(() => refreshNotes());
          }}
        >
          <FilterRow
            label="All Notes"
            active={filter().kind === "all"}
            onSelect={() => void applyFolderFilter({ kind: "all" })}
            depth={0}
            virtual="all"
          />
          <FilterRow
            label="Inbox"
            active={filter().kind === "inbox"}
            onSelect={() => void applyFolderFilter({ kind: "inbox" })}
            depth={0}
            virtual="inbox"
            acceptsNoteDrop
          />
          <For each={folderTree()}>{(node) => <FolderRow node={node} depth={0} />}</For>
        </div>
      </Show>
      <DeleteFolderDialog folder={pendingDelete()} onClose={() => setPendingDeleteSignal(null)} />
    </div>
  );
};

type FilterRowProps = {
  label: string;
  active: boolean;
  onSelect: () => void;
  depth: number;
  virtual: "all" | "inbox";
  /** When true, this virtual row accepts note drops. Inbox routes the
   *  dropped note's folder_id to NULL; All Notes ignores drops. */
  acceptsNoteDrop?: boolean;
};

const FilterRow: Component<FilterRowProps> = (props) => {
  const [hover, setHover] = createSignal(false);
  const handleDragOver = (e: DragEvent) => {
    if (!props.acceptsNoteDrop) return;
    if (!dragNoteId() && !e.dataTransfer?.types.includes(NOTE_MIME)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    if (!hover()) setHover(true);
  };
  const handleDragLeave = () => setHover(false);
  const handleDrop = (e: DragEvent) => {
    setHover(false);
    if (!props.acceptsNoteDrop) return;
    const noteId = e.dataTransfer?.getData(NOTE_MIME) || dragNoteId();
    if (!noteId) return;
    e.preventDefault();
    void moveNoteToFolder(noteId, null);
  };
  return (
    <button
      type="button"
      class="nz-folder-row"
      classList={{ active: props.active, virtual: true, "drop-target": hover() }}
      style={{ "--folder-depth": String(props.depth) }}
      aria-current={props.active}
      onClick={props.onSelect}
      onContextMenu={(e) => e.preventDefault()}
      onDragOver={handleDragOver}
      onDragEnter={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <span class="nz-folder-row-spacer" aria-hidden />
      <span class="nz-folder-row-icon" classList={{ inbox: props.virtual === "inbox" }}>
        <FolderIcon width="12" height="12" />
      </span>
      <span class="nz-folder-row-label">{props.label}</span>
    </button>
  );
};

const FolderRow: Component<{ node: FolderTreeNode; depth: number }> = (props) => {
  const filter = activeFolderFilter;
  const isActive = () => {
    const f = filter();
    return f.kind === "folder" && f.id === props.node.folder.id;
  };
  const hasChildren = () => props.node.children.length > 0;
  const isExpanded = () => expandedFolders().has(props.node.folder.id);
  const [renaming, setRenaming] = createSignal(false);
  const [draftName, setDraftName] = createSignal(props.node.folder.name);
  const [dropHover, setDropHover] = createSignal(false);
  const [selfDragging, setSelfDragging] = createSignal(false);

  // Auto-enter rename mode when this row was just created via the `+`
  // button. The handler called `setPendingRename(newFolderId)` after the
  // store mutation; the new FolderRow mounts here and consumes the flag.
  // `createEffect` (not just `onMount`) covers the rare case where the row
  // already existed and a context-menu "rename" path armed the flag.
  onMount(() => {
    if (consumePendingRename(props.node.folder.id)) {
      setDraftName(props.node.folder.name);
      setRenaming(true);
    }
  });
  createEffect(() => {
    if (pendingRenameFolderId() === props.node.folder.id) {
      if (consumePendingRename(props.node.folder.id)) {
        setDraftName(props.node.folder.name);
        setRenaming(true);
      }
    }
  });

  const handleSelect = () => {
    void applyFolderFilter({
      kind: "folder",
      id: props.node.folder.id,
      include_descendants: true,
    });
  };

  const handleFolderDragStart = (e: DragEvent) => {
    if (!e.dataTransfer) return;
    e.dataTransfer.setData(FOLDER_MIME, props.node.folder.id);
    e.dataTransfer.effectAllowed = "move";
    startFolderDrag(props.node.folder.id);
    setSelfDragging(true);
  };

  const handleFolderDragEnd = () => {
    endFolderDrag();
    setSelfDragging(false);
  };

  const acceptsDrop = (e: DragEvent): "note" | "folder" | null => {
    const types = e.dataTransfer?.types;
    if (!types) return null;
    if (dragNoteId() || types.includes(NOTE_MIME)) return "note";
    if (draggedFolderId() || types.includes(FOLDER_MIME)) {
      // Dropping a folder onto itself or one of its descendants would
      // either be a no-op or create a cycle. Bail before highlighting.
      const draggedId = draggedFolderId();
      if (!draggedId) return "folder";
      if (draggedId === props.node.folder.id) return null;
      if (isAncestorOrSelf(draggedId, props.node.folder.id)) return null;
      return "folder";
    }
    return null;
  };

  const handleDragOver = (e: DragEvent) => {
    const kind = acceptsDrop(e);
    if (!kind) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    if (!dropHover()) setDropHover(true);
  };

  const handleDragLeave = () => setDropHover(false);

  const handleDrop = (e: DragEvent) => {
    const kind = acceptsDrop(e);
    setDropHover(false);
    if (!kind) return;
    e.preventDefault();
    e.stopPropagation();
    if (kind === "note") {
      const noteId = e.dataTransfer?.getData(NOTE_MIME) || dragNoteId();
      if (noteId) void moveNoteToFolder(noteId, props.node.folder.id);
    } else {
      const folderId = e.dataTransfer?.getData(FOLDER_MIME) || draggedFolderId();
      if (!folderId) return;
      // After a folder reparent, the descendants of the active folder
      // filter may have changed, which means a different set of notes
      // is in scope. Refresh once the move is committed.
      void moveFolder(folderId, props.node.folder.id).then(() => refreshNotes());
    }
  };

  const handleContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    showFolderMenu(e, {
      onRename: () => {
        setDraftName(props.node.folder.name);
        setRenaming(true);
      },
      onDelete: () => {
        // Open the confirmation dialog, which handles the actual delete +
        // refresh once the user picks a destination for the notes inside.
        setPendingDeleteSignal(props.node.folder);
      },
      onNewChild: async () => {
        try {
          const folder = await createFolder("New folder", props.node.folder.id);
          setPendingRename(folder.id);
        } catch (err) {
          console.warn("createFolder failed:", err);
        }
      },
    });
  };

  const commitRename = async () => {
    const next = draftName().trim();
    setRenaming(false);
    if (!next || next === props.node.folder.name) return;
    try {
      await renameFolder(props.node.folder.id, next);
    } catch (err) {
      console.warn("renameFolder failed:", err);
    }
  };

  return (
    <>
      <div
        class="nz-folder-row"
        classList={{
          active: isActive(),
          "drop-target": dropHover(),
          "drag-source": selfDragging(),
        }}
        style={{ "--folder-depth": String(props.depth) }}
        role="treeitem"
        aria-expanded={hasChildren() ? isExpanded() : undefined}
        draggable={!renaming()}
        onDragStart={handleFolderDragStart}
        onDragEnd={handleFolderDragEnd}
        onDragOver={handleDragOver}
        onDragEnter={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={handleSelect}
        onContextMenu={handleContextMenu}
      >
        <button
          type="button"
          class="nz-folder-row-twist"
          classList={{ open: isExpanded(), "no-kids": !hasChildren() }}
          aria-label={isExpanded() ? "Collapse" : "Expand"}
          onClick={(e) => {
            e.stopPropagation();
            if (hasChildren()) toggleFolderExpanded(props.node.folder.id);
          }}
        >
          <Show when={hasChildren()}>
            <ChevronRightIcon width="9" height="9" />
          </Show>
        </button>
        <span class="nz-folder-row-icon">
          <FolderIcon width="12" height="12" />
        </span>
        <Show
          when={!renaming()}
          fallback={
            <input
              class="nz-folder-row-input"
              value={draftName()}
              ref={(el) => {
                // Focus + pre-select so the user can type immediately. The
                // setTimeout ensures the input is mounted in the DOM before
                // we touch it; `autofocus` alone doesn't select the text.
                setTimeout(() => {
                  el.focus();
                  el.select();
                }, 0);
              }}
              onClick={(e) => e.stopPropagation()}
              onInput={(e) => setDraftName(e.currentTarget.value)}
              onBlur={() => void commitRename()}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void commitRename();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setRenaming(false);
                }
              }}
            />
          }
        >
          <span class="nz-folder-row-label">{props.node.folder.name}</span>
          <span class="nz-folder-row-count">{props.node.rollupNoteCount}</span>
        </Show>
      </div>
      <Show when={hasChildren() && isExpanded()}>
        <For each={props.node.children}>
          {(child) => <FolderRow node={child} depth={props.depth + 1} />}
        </For>
      </Show>
    </>
  );
};

function showFolderMenu(
  e: MouseEvent,
  actions: { onRename: () => void; onDelete: () => void; onNewChild: () => void },
) {
  const existing = document.getElementById("nz-folder-menu");
  if (existing) existing.remove();
  const menu = document.createElement("div");
  menu.id = "nz-folder-menu";
  menu.className = "nz-row-menu";
  menu.style.left = `${e.clientX}px`;
  menu.style.top = `${e.clientY}px`;
  menu.innerHTML = `
    <button data-action="newchild">New subfolder</button>
    <button data-action="rename">Rename</button>
    <button data-action="delete" class="danger">Delete</button>
  `;
  menu.addEventListener("click", (ev) => {
    const target = ev.target as HTMLElement;
    const action = target.getAttribute("data-action");
    if (action === "rename") actions.onRename();
    else if (action === "delete") actions.onDelete();
    else if (action === "newchild") actions.onNewChild();
    menu.remove();
  });
  const close = (ev: MouseEvent) => {
    if (!menu.contains(ev.target as Node)) menu.remove();
    window.removeEventListener("click", close);
  };
  setTimeout(() => window.addEventListener("click", close), 0);
  document.body.appendChild(menu);
}
