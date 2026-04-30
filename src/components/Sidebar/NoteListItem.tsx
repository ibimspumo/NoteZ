import { type Component, Show, createSignal } from "solid-js";
import { formatRelative, truncate } from "../../lib/format";
import type { NoteSummary } from "../../lib/types";
import { nowTick } from "../../stores/clock";
import { recentlyMovedNoteId } from "../../stores/notes";
import { endNoteDrag, startNoteDrag } from "../../stores/panes";
import { sidebarPreviewLines } from "../../stores/settings";
import { PinIcon } from "../icons";

type Props = {
  note: NoteSummary;
  selected: boolean;
  /** True when the note is open in another pane (not the active one). Used to
   *  give the row a subtler "in use elsewhere" affordance so the user can see
   *  which notes are already on screen. */
  openElsewhere?: boolean;
  /** Called when the row is clicked. The opts let the caller distinguish a
   *  plain click (replace active tab) from a modified click - ⌘/Ctrl-click
   *  asks for "open in a new tab in the active pane" (browser convention). */
  onSelect: (opts?: { newTab?: boolean }) => void;
  onTogglePin: () => void;
  onDelete: () => void;
};

export const NoteListItem: Component<Props> = (props) => {
  const [dragging, setDragging] = createSignal(false);
  let liRef: HTMLLIElement | undefined;

  const title = () => props.note.title.trim() || "New Note";
  const preview = () => truncate(props.note.preview || "", 160);

  const handleDragStart = (e: DragEvent) => {
    console.log("[dnd] dragstart on note", props.note.id, "dataTransfer=", !!e.dataTransfer);
    if (!liRef || !e.dataTransfer) {
      startNoteDrag(props.note.id);
      return;
    }
    e.dataTransfer.setData("application/x-notez-note-id", props.note.id);
    e.dataTransfer.effectAllowed = "move";

    // Custom drag image: clone the row and place it AT the source position
    // briefly so WebKit actually paints it (offscreen-positioned ghosts get
    // skipped by the renderer in WKWebView, leaving setDragImage with
    // nothing to snapshot - which is what produces the "no drag image"
    // bug). The clone is removed on the next animation frame, by which
    // point the OS-level drag image has taken over.
    //
    // The source row gets faded via the `drag-source` class at the same
    // moment, so the user perceives the row lifting out of the sidebar
    // rather than seeing two copies.
    //
    // Height handling: getBoundingClientRect captures the *actual* rendered
    // height, so variable preview-line settings (1 vs 2 vs 3 lines) are
    // handled automatically.
    const rect = liRef.getBoundingClientRect();
    const ghost = liRef.cloneNode(true) as HTMLLIElement;
    ghost.classList.remove("selected", "open-elsewhere", "drag-source");
    ghost.classList.add("nz-drag-ghost");
    ghost.style.position = "fixed";
    ghost.style.top = `${rect.top}px`;
    ghost.style.left = `${rect.left}px`;
    ghost.style.width = `${rect.width}px`;
    ghost.style.height = `${rect.height}px`;
    ghost.style.zIndex = "10000";
    ghost.style.pointerEvents = "none";
    document.body.appendChild(ghost);

    const offsetX = e.clientX - rect.left;
    const offsetY = e.clientY - rect.top;
    e.dataTransfer.setDragImage(ghost, offsetX, offsetY);
    // Wait two animation frames before removing - one for the browser to
    // snapshot, one for the OS-level drag image to take over visually.
    requestAnimationFrame(() => requestAnimationFrame(() => ghost.remove()));

    setDragging(true);
    startNoteDrag(props.note.id);
  };

  const handleDragEnd = () => {
    setDragging(false);
    endNoteDrag();
  };

  return (
    <li
      ref={(el) => (liRef = el)}
      class="nz-note-item"
      classList={{
        selected: props.selected,
        pinned: props.note.is_pinned,
        "open-elsewhere": props.openElsewhere ?? false,
        "drag-source": dragging(),
        "just-moved": recentlyMovedNoteId() === props.note.id,
        "preview-1": sidebarPreviewLines() === 1,
        "preview-2": sidebarPreviewLines() === 2,
      }}
      draggable={true}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onClick={(e) => {
        // ⌘/Ctrl-click: open in a new tab in the active pane (browser
        // convention). Plain click: replace the active tab's note.
        const newTab = e.metaKey || e.ctrlKey;
        props.onSelect(newTab ? { newTab: true } : undefined);
      }}
      onAuxClick={(e) => {
        // Middle-click: open in a new tab. Same convention as web browsers
        // and most editor sidebars.
        if (e.button === 1) {
          e.preventDefault();
          props.onSelect({ newTab: true });
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        showRowMenu(e, props.onTogglePin, props.onDelete, props.note.is_pinned, () =>
          props.onSelect({ newTab: true }),
        );
      }}
    >
      <div class="nz-note-row">
        <span class="nz-note-title">{title()}</span>
        <Show when={props.note.is_pinned}>
          <span class="nz-pin-badge" aria-label="Pinned">
            <PinIcon width="11" height="11" fill="currentColor" />
          </span>
        </Show>
        <span class="nz-note-time">{formatRelative(props.note.updated_at, nowTick())}</span>
      </div>
      <Show when={sidebarPreviewLines() > 0 && preview()}>
        <div class="nz-note-meta">
          <span class="nz-note-preview">{preview()}</span>
        </div>
      </Show>
    </li>
  );
};

function showRowMenu(
  e: MouseEvent,
  onTogglePin: () => void,
  onDelete: () => void,
  isPinned: boolean,
  onOpenInNewTab: () => void,
) {
  // Lightweight inline menu; no external lib.
  const existing = document.getElementById("nz-row-menu");
  if (existing) existing.remove();
  const menu = document.createElement("div");
  menu.id = "nz-row-menu";
  menu.className = "nz-row-menu";
  menu.style.left = `${e.clientX}px`;
  menu.style.top = `${e.clientY}px`;
  menu.innerHTML = `
    <button data-action="newtab">Open in new tab</button>
    <button data-action="pin">${isPinned ? "Unpin" : "Pin"}</button>
    <button data-action="delete" class="danger">Move to Trash</button>
  `;
  menu.addEventListener("click", (ev) => {
    const target = ev.target as HTMLElement;
    const action = target.getAttribute("data-action");
    if (action === "newtab") onOpenInNewTab();
    else if (action === "pin") onTogglePin();
    else if (action === "delete") onDelete();
    menu.remove();
  });
  const close = (ev: MouseEvent) => {
    if (!menu.contains(ev.target as Node)) menu.remove();
    window.removeEventListener("click", close);
  };
  setTimeout(() => window.addEventListener("click", close), 0);
  document.body.appendChild(menu);
}
