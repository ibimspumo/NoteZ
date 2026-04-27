import { Show, type Component } from "solid-js";
import type { NoteSummary } from "../../lib/types";
import { formatRelative, truncate } from "../../lib/format";

type Props = {
  note: NoteSummary;
  selected: boolean;
  onSelect: () => void;
  onTogglePin: () => void;
  onDelete: () => void;
};

export const NoteListItem: Component<Props> = (props) => {
  const title = () => props.note.title.trim() || "New Note";
  const preview = () => truncate(props.note.preview || "", 96);

  return (
    <li
      class="nz-note-item"
      classList={{ selected: props.selected, pinned: props.note.is_pinned }}
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
            <PinIcon />
          </span>
        </Show>
        <span class="nz-note-time">{formatRelative(props.note.updated_at)}</span>
      </div>
      <Show when={preview()}>
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

const PinIcon: Component = () => (
  <svg width="11" height="11" viewBox="0 0 11 11" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
    <path d="M5.5 1L7 3.5V5.5L8.5 7H6.25L5.5 10L4.75 7H2.5L4 5.5V3.5L5.5 1Z" />
  </svg>
);
