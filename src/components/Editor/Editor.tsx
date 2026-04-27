import {
  createEffect,
  createSignal,
  onCleanup,
  Show,
  type Component,
} from "solid-js";
import { $createParagraphNode, $getRoot, type LexicalEditor } from "lexical";
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

  const [activeMatch, setActiveMatch] = createSignal<MentionMatch | null>(null);
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
      confirmSelection: () => {
        const ok = confirmFn?.() ?? false;
        return ok;
      },
    });

    const cleanupChange = handles.editor.registerUpdateListener(() => {
      const json = getEditorStateJSON(handles.editor);
      const text = getPlainText(handles.editor);
      const targets = collectMentionTargets(handles.editor);
      props.onChange({
        contentJson: json,
        contentText: text,
        mentionTargetIds: targets,
      });
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
    if (props.initialJson && props.initialJson !== "{}") {
      loadEditorStateFromJSON(editorRef, props.initialJson);
    } else {
      editorRef.update(() => {
        const root = $getRoot();
        root.clear();
        root.append($createParagraphNode());
      });
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
      <div
        ref={(el) => (containerRef = el)}
        class="nz-editor-content"
        contentEditable={true}
        spellcheck={true}
        data-placeholder="Start writing…"
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
