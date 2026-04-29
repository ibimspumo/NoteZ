import { type Component, Show } from "solid-js";
import { formatRelative, truncate } from "../../lib/format";
import type { NoteSummary } from "../../lib/types";
import { nowTick } from "../../stores/clock";
import { sidebarPreviewLines } from "../../stores/settings";
import { PinIcon } from "../icons";

type Props = {
  note: NoteSummary;
  selected: boolean;
  onSelect: () => void;
  onTogglePin: () => void;
  onDelete: () => void;
};

export const NoteListItem: Component<Props> = (props) => {
  const title = () => props.note.title.trim() || "New Note";
  const preview = () => truncate(props.note.preview || "", 160);

  return (
    <li
      class="nz-note-item"
      classList={{
        selected: props.selected,
        pinned: props.note.is_pinned,
        "preview-1": sidebarPreviewLines() === 1,
        "preview-2": sidebarPreviewLines() === 2,
      }}
      onClick={props.onSelect}
      onContextMenu={(e) => {
        e.preventDefault();
        showRowMenu(e, props.onTogglePin, props.onDelete, props.note.is_pinned);
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
    <button data-action="pin">${isPinned ? "Unpin" : "Pin"}</button>
    <button data-action="delete" class="danger">Move to Trash</button>
  `;
  menu.addEventListener("click", (ev) => {
    const target = ev.target as HTMLElement;
    const action = target.getAttribute("data-action");
    if (action === "pin") onTogglePin();
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
