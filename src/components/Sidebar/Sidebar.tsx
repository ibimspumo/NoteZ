import { For, Show, createMemo, type Component } from "solid-js";
import {
  notesState,
  selectedId,
  setSelectedId,
} from "../../stores/notes";
import { sidebarCollapsed } from "../../stores/ui";
import { NoteListItem } from "./NoteListItem";

type Props = {
  onCreate: () => void;
  onTogglePin: (id: string) => void;
  onDelete: (id: string) => void;
};

export const Sidebar: Component<Props> = (props) => {
  const pinned = createMemo(() => notesState.list.filter((n) => n.is_pinned));
  const others = createMemo(() => notesState.list.filter((n) => !n.is_pinned));

  return (
    <aside
      class="nz-sidebar"
      classList={{ collapsed: sidebarCollapsed() }}
    >
      <div class="nz-sidebar-titlebar" data-tauri-drag-region />
      <div class="nz-sidebar-header" data-tauri-drag-region>
        <div class="nz-app-name" data-tauri-drag-region>NoteZ</div>
        <button
          class="nz-icon-btn"
          aria-label="New note"
          title="New note · ⌘N"
          onClick={props.onCreate}
        >
          <NewNoteIcon />
        </button>
      </div>
      <div class="nz-sidebar-scroll">
        <Show when={pinned().length > 0}>
          <div class="nz-section-label">Pinned</div>
          <ul class="nz-note-list">
            <For each={pinned()}>
              {(n) => (
                <NoteListItem
                  note={n}
                  selected={n.id === selectedId()}
                  onSelect={() => setSelectedId(n.id)}
                  onTogglePin={() => props.onTogglePin(n.id)}
                  onDelete={() => props.onDelete(n.id)}
                />
              )}
            </For>
          </ul>
        </Show>
        <Show when={others().length > 0}>
          <Show when={pinned().length > 0}>
            <div class="nz-section-label">Notes</div>
          </Show>
          <ul class="nz-note-list">
            <For each={others()}>
              {(n) => (
                <NoteListItem
                  note={n}
                  selected={n.id === selectedId()}
                  onSelect={() => setSelectedId(n.id)}
                  onTogglePin={() => props.onTogglePin(n.id)}
                  onDelete={() => props.onDelete(n.id)}
                />
              )}
            </For>
          </ul>
        </Show>
        <Show when={notesState.list.length === 0 && !notesState.loading}>
          <div class="nz-empty-state">
            <p>No notes yet.</p>
            <button class="nz-pill-btn" onClick={props.onCreate}>
              Create your first note
            </button>
          </div>
        </Show>
      </div>
    </aside>
  );
};

const NewNoteIcon: Component = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      d="M3 3.5C3 2.67 3.67 2 4.5 2H9L13 6V12.5C13 13.33 12.33 14 11.5 14H4.5C3.67 14 3 13.33 3 12.5V3.5Z"
      stroke="currentColor"
      stroke-width="1.3"
    />
    <path d="M9 2V6H13" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
    <path d="M8 8.5V11.5M6.5 10H9.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
  </svg>
);
