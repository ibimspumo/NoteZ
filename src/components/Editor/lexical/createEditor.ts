import { CodeNode } from "@lexical/code";
import { LinkNode } from "@lexical/link";
import { ListItemNode, ListNode } from "@lexical/list";
import { TRANSFORMERS, registerMarkdownShortcuts } from "@lexical/markdown";
import { HeadingNode, QuoteNode, registerRichText } from "@lexical/rich-text";
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

  // Lexical's default state has zero children which renders as a 0-height
  // contenteditable; seed an empty paragraph before attaching to the DOM.
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

  // registerRichText wires the command handlers (CONTROLLED_TEXT_INSERTION,
  // INSERT_PARAGRAPH, DELETE_CHARACTER, …) that translate beforeinput events
  // into editor state mutations. @lexical/react does this internally; in
  // vanilla mode it's our responsibility.
  const cleanup = mergeRegister(
    registerRichText(editor),
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
