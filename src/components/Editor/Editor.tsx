import { $createParagraphNode, $getRoot, $isParagraphNode, type LexicalEditor } from "lexical";
import { type Component, Show, createEffect, createSignal, onCleanup } from "solid-js";
import { stringifyEditorState } from "../../lib/editorStringify";
import { api } from "../../lib/tauri";
import type { EditorSnapshot } from "../../views/useSavePipeline";
import { MentionPopover } from "./MentionPopover";
import {
  createNoteZEditor,
  getEditorStateSnapshot,
  getPlainText,
  loadEditorStateFromJSON,
} from "./lexical/createEditor";
import { collectAssetIds } from "./lexical/imageNode";
import { attachMentionClickHandler, collectMentionTargets } from "./lexical/mentionNode";
import { type MentionMatch, insertMention, registerMentionPlugin } from "./lexical/mentionPlugin";
import {
  type SerializedSelection,
  captureSelection,
  restoreSelection,
} from "./lexical/selectionPath";

// Settings-table key namespace for per-note cursor persistence.
const cursorKey = (noteId: string) => `cursor:${noteId}`;
const PERSIST_DEBOUNCE_MS = 800;

export type EditorChange = {
  /**
   * Compute the full save payload - JSON state, plain text, mention targets,
   * asset ids. Deferred so the cost only lands once per save, not once per
   * keystroke. JSON.stringify runs in a worker.
   *
   * Returns `null` if the editor is gone (note unmounted between schedule and call).
   */
  snapshot: () => Promise<EditorSnapshot | null>;
};

type EditorProps = {
  noteId: string;
  initialJson: string;
  onChange: (change: EditorChange) => void;
  onOpenNote: (noteId: string) => void;
  onReady?: (editor: LexicalEditor | null) => void;
};

export const Editor: Component<EditorProps> = (props) => {
  let containerRef: HTMLDivElement | undefined;
  let editorRef: LexicalEditor | undefined;
  let lastNoteId: string | null = null;
  let suppressChange = false;
  // Per-note cursor memory so switching between notes lands the caret where
  // the user left it. The map is the in-session cache; persistence lives in
  // the `settings` table (key `cursor:<noteId>`) for cross-restart restore.
  const selectionsByNote = new Map<string, SerializedSelection>();
  let liveSelection: SerializedSelection | null = null;
  let persistTimer: number | null = null;

  const flushPersist = () => {
    persistTimer = null;
    const id = lastNoteId;
    const sel = liveSelection;
    if (!id || !sel) return;
    void api.setSetting(cursorKey(id), JSON.stringify(sel)).catch((e) => {
      console.warn("failed to persist cursor", e);
    });
  };
  const schedulePersist = () => {
    if (persistTimer != null) clearTimeout(persistTimer);
    persistTimer = window.setTimeout(flushPersist, PERSIST_DEBOUNCE_MS);
  };

  const [activeMatch, setActiveMatch] = createSignal<MentionMatch | null>(null);
  const [isEmpty, setIsEmpty] = createSignal(true);
  let confirmFn: (() => boolean) | null = null;
  let navigateFn: ((dir: "up" | "down") => void) | null = null;

  createEffect(() => {
    if (!containerRef) return;
    const handles = createNoteZEditor(containerRef);
    editorRef = handles.editor;
    props.onReady?.(handles.editor);

    const cleanupClick = attachMentionClickHandler(containerRef, (id) => {
      props.onOpenNote(id);
    });

    const cleanupMentions = registerMentionPlugin(handles.editor, {
      onOpen: (m) => setActiveMatch(m),
      onUpdate: (m) => setActiveMatch(m),
      onClose: () => setActiveMatch(null),
      isOpen: () => activeMatch() !== null,
      navigate: (dir) => navigateFn?.(dir),
      confirmSelection: () => confirmFn?.() ?? false,
    });

    // Lazy snapshot: bind the editor handle once, the host calls it on demand.
    const snapshot = async (): Promise<EditorSnapshot | null> => {
      const ed = editorRef;
      if (!ed) return null;
      const stateObj = getEditorStateSnapshot(ed);
      const text = getPlainText(ed);
      const mentionTargetIds = collectMentionTargets(ed);
      const assetIds = collectAssetIds(ed);
      const contentJson = await stringifyEditorState(stateObj);
      return { contentJson, contentText: text, mentionTargetIds, assetIds };
    };

    const cleanupChange = handles.editor.registerUpdateListener(
      ({ dirtyElements, dirtyLeaves, editorState }) => {
        // Cheap: track empty state for the placeholder, no stringify here.
        editorState.read(() => {
          const root = $getRoot();
          const size = root.getChildrenSize();
          if (size === 0) {
            setIsEmpty(true);
          } else if (size === 1) {
            const first = root.getFirstChild();
            if (first && $isParagraphNode(first) && first.getTextContentSize() === 0) {
              setIsEmpty(true);
            } else {
              setIsEmpty(false);
            }
          } else {
            setIsEmpty(false);
          }
        });

        // Track latest caret position for per-note cursor memory. Skipped during
        // state-load (`suppressChange`) so we don't capture the loaded state's
        // default selection right after switching.
        if (!suppressChange) {
          const captured = captureSelection(handles.editor);
          if (captured) {
            liveSelection = captured;
            schedulePersist();
          }
        }

        if (suppressChange) return;
        if (dirtyElements.size === 0 && dirtyLeaves.size === 0) return;

        // Don't compute the snapshot here - pass the deferred provider to the host.
        // The save pipeline debounces and pulls the snapshot once per save burst.
        props.onChange({ snapshot });
      },
    );

    onCleanup(() => {
      // Flush any pending cursor persist before tearing down - best-effort,
      // since IPC during shutdown isn't guaranteed to land.
      if (persistTimer != null) {
        clearTimeout(persistTimer);
        flushPersist();
      }
      cleanupChange();
      cleanupMentions();
      cleanupClick();
      props.onReady?.(null);
      handles.destroy();
    });
  });

  createEffect(() => {
    const id = props.noteId;
    if (!editorRef) return;
    if (id === lastNoteId) return;

    // Save the outgoing note's caret position before we wipe state. Cancel
    // any pending debounced persist for the outgoing note and write
    // synchronously instead so a fast switch doesn't lose the position.
    if (lastNoteId !== null && liveSelection) {
      selectionsByNote.set(lastNoteId, liveSelection);
      if (persistTimer != null) {
        clearTimeout(persistTimer);
        persistTimer = null;
      }
      const outgoingId = lastNoteId;
      const outgoingSel = liveSelection;
      void api
        .setSetting(cursorKey(outgoingId), JSON.stringify(outgoingSel))
        .catch((e) => console.warn("failed to persist cursor", e));
    }
    lastNoteId = id;
    liveSelection = null;

    suppressChange = true;
    if (props.initialJson && props.initialJson !== "{}") {
      loadEditorStateFromJSON(editorRef, props.initialJson);
    } else {
      editorRef.update(() => {
        const root = $getRoot();
        root.clear();
        root.append($createParagraphNode());
      });
    }

    const cachedSel = selectionsByNote.get(id) ?? null;
    queueMicrotask(() => {
      suppressChange = false;
      if (cachedSel && editorRef) {
        restoreSelection(editorRef, cachedSel);
      }
      containerRef?.focus();
      editorRef?.focus();
    });

    // Cache miss → first time we see this note this session. Fetch the
    // persisted cursor from the settings table; if the user is still on this
    // note when it returns, restore it. The race against rapid switches is
    // guarded by the `lastNoteId !== id` check.
    if (!cachedSel) {
      void api
        .getSetting(cursorKey(id))
        .then((raw) => {
          if (lastNoteId !== id || !raw || !editorRef) return;
          // The user might have moved the caret already since the load (e.g.
          // by clicking inside the editor) - don't stomp on a fresh selection.
          if (liveSelection) return;
          let parsed: SerializedSelection | null = null;
          try {
            parsed = JSON.parse(raw) as SerializedSelection;
          } catch (e) {
            console.warn("failed to parse persisted cursor", e);
            return;
          }
          selectionsByNote.set(id, parsed);
          restoreSelection(editorRef, parsed);
        })
        .catch((e) => console.warn("failed to read persisted cursor", e));
    }
  });

  const handleSelect = (noteId: string, title: string) => {
    const m = activeMatch();
    if (!m || !editorRef) return;
    insertMention(editorRef, m, noteId, title);
    setActiveMatch(null);
  };

  return (
    <div class="nz-editor-shell">
      <Show when={isEmpty()}>
        <div class="nz-editor-placeholder" aria-hidden="true">
          Title
        </div>
      </Show>
      <div
        ref={(el) => (containerRef = el)}
        class="nz-editor-content"
        contentEditable={true}
        spellcheck={true}
      />
      <Show when={activeMatch()}>
        {(match) => (
          <MentionPopover
            match={match()}
            currentNoteId={props.noteId}
            onSelect={handleSelect}
            onClose={() => setActiveMatch(null)}
            registerNavigate={(fn) => (navigateFn = fn)}
            registerConfirm={(fn) => (confirmFn = fn)}
          />
        )}
      </Show>
    </div>
  );
};
