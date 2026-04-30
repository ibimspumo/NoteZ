import type { LexicalEditor } from "lexical";
import { type Component, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { formatAbsoluteDate, formatRelative } from "../../lib/format";
import type { Note } from "../../lib/types";
import { nowTick } from "../../stores/clock";
import { loadNote, reloadNote } from "../../stores/notes";
import {
  type PaneId,
  type TabId,
  openNoteInPane,
  registerTabApi,
  registerTabEditor,
} from "../../stores/panes";
import { useSavePipeline } from "../../views/useSavePipeline";
import { Editor, type EditorChange } from "../Editor/Editor";
import { EmptyPanePicker } from "./EmptyPanePicker";

type Props = {
  paneId: PaneId;
  tabId: TabId;
  noteId: string | null;
  /** True iff this tab is the active tab in its pane. Inactive tabs are
   *  display:none in the parent and don't receive focus, but the Lexical
   *  instance and save pipeline stay alive so switching back is instant. */
  isActive: boolean;
  onOpenNote: (id: string, opts?: { split: boolean }) => void;
  onCreate: () => Promise<void>;
};

/**
 * Single-tab content. Each tab owns its own Lexical editor instance and save
 * pipeline. When the tab is hidden (CSS display:none from the parent) the
 * editor stays mounted: the editor state, undo history, scroll position, and
 * save pipeline all persist so switching back is a CSS visibility flip rather
 * than a remount. Memory cost is bounded by the number of tabs the user
 * actually opens.
 */
export const TabContent: Component<Props> = (props) => {
  const [activeNote, setActiveNote] = createSignal<Note | null>(null);
  const [editorKey, setEditorKey] = createSignal(0);

  const save = useSavePipeline({
    onSaved: (updated) => {
      const cur = activeNote();
      if (cur && cur.id === updated.id) setActiveNote(updated);
    },
  });

  const handleChange = (change: EditorChange) => {
    const id = props.noteId;
    if (!id) return;
    save.markDirty(id, change.snapshot);
  };

  // Load note when noteId changes. Wait for any in-flight save targeting the
  // previous note to land before swapping the baseline. If the note can't be
  // loaded (e.g. it was purged between sessions and the layout still
  // referenced it), null the tab's noteId so the picker shows up instead of
  // a stuck spinner.
  createEffect(async () => {
    const id = props.noteId;
    if (!id) {
      setActiveNote(null);
      return;
    }
    if (save.hasPending()) await save.flush();
    try {
      const note = await loadNote(id);
      setActiveNote(note);
      save.resetBaseline(note.id, note.content_json);
      setEditorKey((k) => k + 1);
    } catch (e) {
      console.warn(`[TabContent ${props.tabId}] loadNote failed for ${id}`, e);
      setActiveNote(null);
      // Writing to the panes store from inside an effect that depends on its
      // own props can cause a reactive loop. Schedule it out-of-band so the
      // current update cycle finishes first.
      queueMicrotask(() => {
        openNoteInPane(props.paneId, null);
      });
    }
  });

  onMount(() => {
    registerTabApi(props.tabId, {
      flushSave: save.flush,
      hasPendingSave: save.hasPending,
      resetBaseline: save.resetBaseline,
      reloadFromBackend,
      applyExternalUpdate,
      syncActiveNote,
      savingState: save.savingState,
    });
  });

  onCleanup(() => {
    registerTabApi(props.tabId, null);
    registerTabEditor(props.tabId, null);
  });

  const reloadFromBackend = async (noteId: string) => {
    await save.flush();
    const note = await reloadNote(noteId);
    if (props.noteId === noteId) {
      setActiveNote(note);
      save.resetBaseline(note.id, note.content_json);
      setEditorKey((k) => k + 1);
    }
  };

  const applyExternalUpdate = (note: Note) => {
    setActiveNote(note);
    save.resetBaseline(note.id, note.content_json);
    setEditorKey((k) => k + 1);
  };

  const syncActiveNote = (note: Note) => {
    if (activeNote()?.id === note.id) setActiveNote(note);
  };

  const handleEditorReady = (editor: LexicalEditor | null) => {
    registerTabEditor(props.tabId, editor);
  };

  return (
    <Show
      when={activeNote()}
      fallback={<EmptyPanePicker paneId={props.paneId} onCreate={props.onCreate} />}
    >
      {(note) => (
        <div class="nz-editor-wrap">
          <div class="nz-meta-bar">
            <span class="nz-meta-primary">{formatAbsoluteDate(note().created_at)}</span>
            <span class="nz-meta-dot" aria-hidden="true">
              ·
            </span>
            <span class="nz-meta-secondary">
              Last edited {formatRelative(note().updated_at, nowTick())}
            </span>
            <Show when={note().is_pinned}>
              <span class="nz-meta-dot" aria-hidden="true">
                ·
              </span>
              <span class="nz-meta-pin">Pinned</span>
            </Show>
          </div>
          <div data-editor-key={editorKey()}>
            <Editor
              noteId={note().id}
              initialJson={note().content_json}
              onChange={handleChange}
              onOpenNote={props.onOpenNote}
              onReady={handleEditorReady}
            />
          </div>
        </div>
      )}
    </Show>
  );
};
