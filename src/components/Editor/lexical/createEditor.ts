import { CodeNode } from "@lexical/code";
import { LinkNode } from "@lexical/link";
import { ListItemNode, ListNode } from "@lexical/list";
import { TRANSFORMERS, registerMarkdownShortcuts } from "@lexical/markdown";
import { HeadingNode, QuoteNode } from "@lexical/rich-text";
import { mergeRegister } from "@lexical/utils";
import { registerHistory, createEmptyHistoryState } from "@lexical/history";
import {
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
      console.error("[Lexical]", error);
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

  editor.setRootElement(rootEl);

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
