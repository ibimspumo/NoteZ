import { CodeNode } from "@lexical/code";
import { LinkNode } from "@lexical/link";
import { ListItemNode, ListNode } from "@lexical/list";
import { TRANSFORMERS, registerMarkdownShortcuts } from "@lexical/markdown";
import { HeadingNode, QuoteNode } from "@lexical/rich-text";
import { mergeRegister } from "@lexical/utils";
import { registerHistory, createEmptyHistoryState } from "@lexical/history";
import {
  $createParagraphNode,
  $getRoot,
  createEditor as lexicalCreateEditor,
  type LexicalEditor,
} from "lexical";
import { MentionNode } from "./mentionNode";
import { editorTheme } from "./theme";

export type EditorHandles = {
  editor: LexicalEditor;
  destroy: () => void;
};

export function createNoteZEditor(rootEl: HTMLElement): EditorHandles {
  console.log("[NoteZ] creating Lexical editor on", rootEl);

  const editor = lexicalCreateEditor({
    namespace: "notez",
    theme: editorTheme,
    onError: (error) => {
      console.error("[Lexical] runtime error:", error);
    },
    nodes: [
      HeadingNode,
      QuoteNode,
      ListNode,
      ListItemNode,
      LinkNode,
      CodeNode,
      MentionNode,
    ],
  });

  // Initialise state with one empty paragraph BEFORE attaching to DOM —
  // Lexical's default state has zero children which renders as a 0-height
  // contenteditable that nothing can be typed into.
  editor.update(
    () => {
      const root = $getRoot();
      if (root.getChildrenSize() === 0) {
        root.append($createParagraphNode());
      }
    },
    { discrete: true, tag: "history-merge" },
  );

  editor.setRootElement(rootEl);
  console.log(
    "[NoteZ] setRootElement done — contenteditable=",
    rootEl.getAttribute("contenteditable"),
    "rect=",
    rootEl.getBoundingClientRect(),
  );

  const cleanup = mergeRegister(
    registerHistory(editor, createEmptyHistoryState(), 300),
    registerMarkdownShortcuts(editor, TRANSFORMERS),
  );

  return {
    editor,
    destroy: () => {
      cleanup();
      editor.setRootElement(null);
    },
  };
}

export function getPlainText(editor: LexicalEditor): string {
  let text = "";
  editor.getEditorState().read(() => {
    text = $getRoot().getTextContent();
  });
  return text;
}

export function getEditorStateJSON(editor: LexicalEditor): string {
  return JSON.stringify(editor.getEditorState().toJSON());
}

export function loadEditorStateFromJSON(editor: LexicalEditor, json: string) {
  if (!json || json === "{}" || json.trim().length === 0) {
    return;
  }
  try {
    const parsed = editor.parseEditorState(json);
    editor.setEditorState(parsed);
  } catch (e) {
    console.warn("failed to parse editor state, leaving blank", e);
  }
}
