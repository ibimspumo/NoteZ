import {
  createEffect,
  createSignal,
  onCleanup,
  Show,
  type Component,
} from "solid-js";
import {
  $createParagraphNode,
  $getRoot,
  $isParagraphNode,
  type LexicalEditor,
} from "lexical";
import {
  createNoteZEditor,
  getEditorStateSnapshot,
  getPlainText,
  loadEditorStateFromJSON,
} from "./lexical/createEditor";
import {
  attachMentionClickHandler,
  collectMentionTargets,
} from "./lexical/mentionNode";
import { collectAssetIds } from "./lexical/imageNode";
import {
  insertMention,
  registerMentionPlugin,
  type MentionMatch,
} from "./lexical/mentionPlugin";
import { MentionPopover } from "./MentionPopover";
import { stringifyEditorState } from "../../lib/editorStringify";
import type { EditorSnapshot } from "../../views/useSavePipeline";

export type EditorChange = {
  /**
   * Compute the full save payload — JSON state, plain text, mention targets,
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
};

export const Editor: Component<EditorProps> = (props) => {
  let containerRef: HTMLDivElement | undefined;
  let editorRef: LexicalEditor | undefined;
  let lastNoteId: string | null = null;
  let suppressChange = false;

  const [activeMatch, setActiveMatch] = createSignal<MentionMatch | null>(null);
  const [isEmpty, setIsEmpty] = createSignal(true);
  let confirmFn: (() => boolean) | null = null;
  let navigateFn: ((dir: "up" | "down") => void) | null = null;

  createEffect(() => {
    if (!containerRef) return;
    const handles = createNoteZEditor(containerRef);
    editorRef = handles.editor;

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

    const cleanupChange = handles.editor.registerUpdateListener(({ dirtyElements, dirtyLeaves, editorState }) => {
      // Cheap: track empty state for the placeholder, no stringify here.
      editorState.read(() => {
        const root = $getRoot();
        const size = root.getChildrenSize();
        if (size === 0) {
          setIsEmpty(true);
          return;
        }
        if (size === 1) {
          const first = root.getFirstChild();
          if (first && $isParagraphNode(first) && first.getTextContentSize() === 0) {
            setIsEmpty(true);
            return;
          }
        }
        setIsEmpty(false);
      });

      if (suppressChange) return;
      if (dirtyElements.size === 0 && dirtyLeaves.size === 0) return;

      // Don't compute the snapshot here — pass the deferred provider to the host.
      // The save pipeline debounces and pulls the snapshot once per save burst.
      props.onChange({ snapshot });
    });

    onCleanup(() => {
      cleanupChange();
      cleanupMentions();
      cleanupClick();
      handles.destroy();
    });
  });

  createEffect(() => {
    const id = props.noteId;
    if (!editorRef) return;
    if (id === lastNoteId) return;
    lastNoteId = id;

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
    queueMicrotask(() => {
      suppressChange = false;
      containerRef?.focus();
      editorRef?.focus();
    });
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
