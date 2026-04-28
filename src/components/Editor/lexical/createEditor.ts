import { CodeNode } from "@lexical/code";
import { LinkNode } from "@lexical/link";
import {
  ListItemNode,
  ListNode,
  registerCheckList,
  registerList,
} from "@lexical/list";
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
import { ImageNode } from "./imageNode";
import { registerImagePlugin } from "./imagePlugin";
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
    registerCheckList(editor),
    registerMarkdownShortcuts(editor, TRANSFORMERS),
    registerImagePlugin(editor, rootEl),
  );

  // Lexical's default text/plain serializer concatenates getTextContent()
  // across nodes, which drops list markers - paste into another app and
  // bullets/numbers vanish. Run after Lexical's copy handler (attached during
  // setRootElement) and overwrite text/plain with a marker-aware version.
  // text/html and application/x-lexical-editor stay untouched.
  const detachCopy = registerListAwareCopy(rootEl);

  return {
    editor,
    destroy: () => {
      detachCopy();
      cleanup();
      editor.setRootElement(null);
    },
  };
}

function registerListAwareCopy(rootEl: HTMLElement): () => void {
  const handler = (event: ClipboardEvent) => {
    if (!event.clipboardData) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (!rootEl.contains(range.commonAncestorContainer)) return;

    const wrapper = document.createElement("div");
    wrapper.appendChild(range.cloneContents());
    const text = serializeWithListMarkers(wrapper);
    if (text) {
      event.clipboardData.setData("text/plain", text);
    }
  };
  rootEl.addEventListener("copy", handler);
  rootEl.addEventListener("cut", handler);
  return () => {
    rootEl.removeEventListener("copy", handler);
    rootEl.removeEventListener("cut", handler);
  };
}

function serializeWithListMarkers(root: HTMLElement): string {
  const out: string[] = [];
  const endsWithNewline = () =>
    out.length > 0 && out[out.length - 1].endsWith("\n");

  const walk = (node: Node, listDepth: number) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out.push(node.textContent ?? "");
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const el = node as HTMLElement;
    const tag = el.tagName.toLowerCase();

    if (tag === "ul" || tag === "ol") {
      let index = 0;
      for (const child of Array.from(el.children)) {
        if (child.tagName.toLowerCase() !== "li") continue;
        // Lexical wraps nested lists in an empty <li class="nz-li-nested">
        // - skip its marker and descend into the inner list.
        if (child.classList.contains("nz-li-nested")) {
          walk(child, listDepth + 1);
          continue;
        }
        index++;
        if (out.length > 0 && !endsWithNewline()) out.push("\n");
        const indent = "  ".repeat(listDepth);
        const marker = tag === "ol" ? `${index}. ` : "• ";
        out.push(indent + marker);
        walk(child, listDepth + 1);
      }
      return;
    }

    if (tag === "li") {
      for (const child of Array.from(el.childNodes)) walk(child, listDepth);
      return;
    }

    if (tag === "br") {
      out.push("\n");
      return;
    }

    if (tag === "p" || tag === "div" || tag === "blockquote" || /^h[1-6]$/.test(tag)) {
      if (out.length > 0 && !endsWithNewline()) out.push("\n");
      for (const child of Array.from(el.childNodes)) walk(child, listDepth);
      if (!endsWithNewline()) out.push("\n");
      return;
    }

    for (const child of Array.from(el.childNodes)) walk(child, listDepth);
  };

  walk(root, 0);
  return out.join("").replace(/\n+$/, "");
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

