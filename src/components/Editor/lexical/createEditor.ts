import { CodeNode } from "@lexical/code";
import { LinkNode } from "@lexical/link";
import { ListItemNode, ListNode, registerList } from "@lexical/list";
import { TRANSFORMERS, registerMarkdownShortcuts } from "@lexical/markdown";
import { HeadingNode, QuoteNode, registerRichText } from "@lexical/rich-text";
import { mergeRegister } from "@lexical/utils";
import { registerHistory, createEmptyHistoryState } from "@lexical/history";
import {
  $createParagraphNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_LOW,
  DRAGOVER_COMMAND,
  DROP_COMMAND,
  PASTE_COMMAND,
  createEditor as lexicalCreateEditor,
  type LexicalEditor,
} from "lexical";
import { api } from "../../../lib/tauri";
import { $createImageNode, ImageNode } from "./imageNode";
import { MentionNode } from "./mentionNode";
import { editorTheme } from "./theme";

export type EditorHandles = {
  editor: LexicalEditor;
  destroy: () => void;
};

const ACCEPTED_IMAGE_MIMES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/webp",
]);

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
      ImageNode,
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
    registerList(editor),
    registerMarkdownShortcuts(editor, TRANSFORMERS),
    registerImageDropAndPaste(editor),
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

/** Plain-object snapshot of the editor state (no stringify). */
export function getEditorStateSnapshot(editor: LexicalEditor): unknown {
  return editor.getEditorState().toJSON();
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

// --- image paste / drop ---

function registerImageDropAndPaste(editor: LexicalEditor): () => void {
  return mergeRegister(
    editor.registerCommand(
      PASTE_COMMAND,
      (event: ClipboardEvent) => {
        const files = collectImageFiles(event.clipboardData);
        if (files.length === 0) return false;
        event.preventDefault();
        void importImageFiles(editor, files);
        return true;
      },
      COMMAND_PRIORITY_LOW,
    ),
    editor.registerCommand(
      DRAGOVER_COMMAND,
      (event: DragEvent) => {
        if (event.dataTransfer && hasImage(event.dataTransfer)) {
          event.preventDefault();
          return true;
        }
        return false;
      },
      COMMAND_PRIORITY_LOW,
    ),
    editor.registerCommand(
      DROP_COMMAND,
      (event: DragEvent) => {
        const files = collectImageFiles(event.dataTransfer);
        if (files.length === 0) return false;
        event.preventDefault();
        void importImageFiles(editor, files);
        return true;
      },
      COMMAND_PRIORITY_LOW,
    ),
  );
}

function hasImage(dt: DataTransfer): boolean {
  for (const f of dt.files) {
    if (ACCEPTED_IMAGE_MIMES.has(f.type)) return true;
  }
  return false;
}

function collectImageFiles(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  const out: File[] = [];
  for (const f of dt.files) {
    if (ACCEPTED_IMAGE_MIMES.has(f.type)) out.push(f);
  }
  return out;
}

function extFromMime(mime: string): string {
  switch (mime.toLowerCase()) {
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    default:
      return "bin";
  }
}

async function importImageFiles(editor: LexicalEditor, files: File[]) {
  for (const file of files) {
    try {
      const buf = await file.arrayBuffer();
      // Tauri 2 transports `Vec<u8>` as `number[]` over IPC. For images this
      // dominates the cost — a 2 MB photo is 2 M numbers. That's still fast
      // (~30 ms in Chromium) but if it becomes a bottleneck we can switch to
      // a Tauri Channel for streamed bytes.
      const bytes = Array.from(new Uint8Array(buf));
      const ref = await api.saveAsset(bytes, file.type);
      editor.update(() => {
        const node = $createImageNode({
          assetId: ref.id,
          ext: extFromMime(ref.mime),
          width: ref.width,
          height: ref.height,
          blurhash: ref.blurhash,
          alt: file.name,
        });
        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          selection.insertNodes([node]);
        } else {
          $getRoot().append(node);
        }
      });
    } catch (e) {
      console.error("import image failed:", e);
    }
  }
}
