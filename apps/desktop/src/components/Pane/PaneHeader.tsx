import { type Component, Show, createMemo } from "solid-js";
import { getCachedNote, notesState } from "../../stores/notes";
import { type PaneId, closePane, totalPaneCount } from "../../stores/panes";
import { PinIcon } from "../icons";

type Props = {
  paneId: PaneId;
  /** noteId of the single tab in this pane (or null if it's an empty tab).
   *  Resolved by the parent from `pane.tabs[activeTabIdx].noteId`. */
  noteId: string | null;
};

/**
 * Pane header for the single-tab + multi-pane case. Shows the active tab's
 * note title, pin state, and a close-pane button. Looks up the note from the
 * cache or sidebar summaries so changes to the title from inside the editor
 * propagate up automatically (cache is updated on every save).
 */
export const PaneHeader: Component<Props> = (props) => {
  const note = createMemo(() => {
    const id = props.noteId;
    if (!id) return null;
    // Read pinned / items reactively so the title falls back gracefully right
    // after layout restore, before the editor has populated the cache.
    const cached = getCachedNote(id);
    if (cached) return cached;
    return (
      notesState.pinned.find((n) => n.id === id) ??
      notesState.items.find((n) => n.id === id) ??
      null
    );
  });

  const handleClose = (e: MouseEvent) => {
    e.stopPropagation();
    closePane(props.paneId);
  };

  // The very last pane keeps its close button hidden - closing it would clear
  // the only editor and leave a stranded empty pane that the user has to fill
  // anyway. Just hide the affordance to avoid the dead-end interaction.
  const showClose = () => totalPaneCount() > 1;

  const title = () => {
    const n = note();
    if (!n) return props.noteId ? "Untitled" : "New tab";
    return n.title?.trim() || "Untitled";
  };
  const isPinned = () => note()?.is_pinned ?? false;

  return (
    <div class="nz-pane-header">
      <span class="nz-pane-header-title">{title()}</span>
      <Show when={isPinned()}>
        <span class="nz-pane-header-pin" aria-label="Pinned">
          <PinIcon width="10" height="10" fill="currentColor" />
        </span>
      </Show>
      <Show when={showClose()}>
        <button
          type="button"
          class="nz-pane-header-close"
          onClick={handleClose}
          aria-label="Close pane"
          title="Close pane"
        >
          ×
        </button>
      </Show>
    </div>
  );
};
