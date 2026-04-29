import type { LexicalEditor } from "lexical";
import { type Component, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { formatAbsoluteDate, formatRelative } from "../../lib/format";
import type { Note } from "../../lib/types";
import { nowTick } from "../../stores/clock";
import { loadNote, reloadNote } from "../../stores/notes";
import {
  type PaneId,
  activePaneId,
  dragNoteId,
  openNoteInPane,
  registerPaneApi,
  registerPaneEditor,
  setActivePaneId,
} from "../../stores/panes";
import { useSavePipeline } from "../../views/useSavePipeline";
import { Editor, type EditorChange } from "../Editor/Editor";
import { EmptyPanePicker } from "./EmptyPanePicker";
import { PaneDropOverlay } from "./PaneDropOverlay";
import { PaneHeader } from "./PaneHeader";

type Props = {
  paneId: PaneId;
  noteId: string | null;
  /** Pane chrome (title row + close button). Hidden when only one pane exists
   *  so the single-pane layout looks identical to the pre-split version. */
  showHeader: boolean;
  onOpenNote: (id: string, opts?: { split: boolean }) => void;
  onCreate: () => Promise<void>;
};

export const EditorPane: Component<Props> = (props) => {
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
  // referenced it), null the pane's noteId so the picker shows up instead of
  // a stuck spinner.
  createEffect(async () => {
    const id = props.noteId;
    console.log(`[EditorPane ${props.paneId}] noteId effect, id=${id}`);
    if (!id) {
      setActiveNote(null);
      return;
    }
    if (save.hasPending()) await save.flush();
    try {
      const note = await loadNote(id);
      console.log(`[EditorPane ${props.paneId}] loadNote ok`);
      setActiveNote(note);
      save.resetBaseline(note.id, note.content_json);
      setEditorKey((k) => k + 1);
    } catch (e) {
      console.warn(`[EditorPane ${props.paneId}] loadNote failed for ${id}`, e);
      setActiveNote(null);
      // NOTE: writing to the panes store from inside an effect that depends
      // on its read of props.noteId can cause a reactive loop. Schedule it
      // out-of-band via queueMicrotask so the current update cycle finishes
      // before the panes store mutation kicks off the next one.
      queueMicrotask(() => {
        openNoteInPane(props.paneId, null);
      });
    }
  });

  onMount(() => {
    console.log(`[EditorPane ${props.paneId}] mounted, noteId=${props.noteId}`);
    registerPaneApi(props.paneId, {
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
    console.log(`[EditorPane ${props.paneId}] unmounting`);
    registerPaneApi(props.paneId, null);
    registerPaneEditor(props.paneId, null);
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
    console.log(`[EditorPane ${props.paneId}] handleEditorReady editor=${!!editor}`);
    registerPaneEditor(props.paneId, editor);
  };

  // mousedown wins over click for activation - the mention-popover and other
  // inner components stop click propagation, but the mousedown bubbles first.
  const handleActivate = () => setActivePaneId(props.paneId);

  return (
    <div
      class="nz-pane"
      classList={{ active: activePaneId() === props.paneId }}
      onMouseDown={handleActivate}
      onFocusIn={handleActivate}
    >
      <Show when={props.showHeader}>
        <PaneHeader
          paneId={props.paneId}
          title={activeNote()?.title ?? ""}
          isPinned={activeNote()?.is_pinned ?? false}
        />
      </Show>
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
      <Show when={dragNoteId() !== null}>
        <PaneDropOverlay paneId={props.paneId} />
      </Show>
    </div>
  );
};
