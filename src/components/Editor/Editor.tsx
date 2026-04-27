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
  getEditorStateJSON,
  getPlainText,
  loadEditorStateFromJSON,
} from "./lexical/createEditor";
import {
  attachMentionClickHandler,
  collectMentionTargets,
} from "./lexical/mentionNode";
import {
  insertMention,
  registerMentionPlugin,
  type MentionMatch,
} from "./lexical/mentionPlugin";
import { MentionPopover } from "./MentionPopover";

export type EditorChange = {
  contentJson: string;
  contentText: string;
  mentionTargetIds: string[];
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

    const cleanupChange = handles.editor.registerUpdateListener(({ dirtyElements, dirtyLeaves, editorState }) => {
      // Compute empty-state on every editor change for the placeholder overlay.
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
      const json = getEditorStateJSON(handles.editor);
      const text = getPlainText(handles.editor);
      const targets = collectMentionTargets(handles.editor);
      props.onChange({ contentJson: json, contentText: text, mentionTargetIds: targets });
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
        <div
          class="nz-editor-placeholder"
          aria-hidden="true"
          onMouseDown={(e) => {
            e.preventDefault();
            editorRef?.focus();
          }}
        >
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
