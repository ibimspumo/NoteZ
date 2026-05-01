import { CodeNode } from "@lexical/code";
import { createEmptyHistoryState, registerHistory } from "@lexical/history";
import { LinkNode } from "@lexical/link";
import { ListItemNode, ListNode, registerCheckList, registerList } from "@lexical/list";
import { TRANSFORMERS, registerMarkdownShortcuts } from "@lexical/markdown";
import { HeadingNode, QuoteNode, registerRichText } from "@lexical/rich-text";
import { mergeRegister } from "@lexical/utils";
import {
  $createParagraphNode,
  $getRoot,
  COMMAND_PRIORITY_EDITOR,
  INDENT_CONTENT_COMMAND,
  KEY_TAB_COMMAND,
  type LexicalEditor,
  OUTDENT_CONTENT_COMMAND,
  createEditor as lexicalCreateEditor,
} from "lexical";
import { registerEditorRefs } from "./editorRefs";
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
    // Mutation-based tracking of mention/image refs - replaces the old
    // O(node-map) scan in collectMentionTargets / collectAssetIds.
    registerEditorRefs(editor),
    // Tab indents (or nests list items via registerList); Shift+Tab outdents.
    // Runs at EDITOR priority so the mention popover's LOW-priority Tab
    // handler still wins when the popover is open.
    editor.registerCommand(
      KEY_TAB_COMMAND,
      (event) => {
        event.preventDefault();
        return editor.dispatchCommand(
          event.shiftKey ? OUTDENT_CONTENT_COMMAND : INDENT_CONTENT_COMMAND,
          undefined,
        );
      },
      COMMAND_PRIORITY_EDITOR,
    ),
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
  const endsWithNewline = () => out.length > 0 && out[out.length - 1].endsWith("\n");

  // Independent depth counters for ul / ol so each list type cycles its
  // markers (• ◦ ▪ for ul; 1. a. i. for ol) matching the CSS visual.
  const walk = (node: Node, ulDepth: number, olDepth: number) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out.push(node.textContent ?? "");
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const el = node as HTMLElement;
    const tag = el.tagName.toLowerCase();

    if (tag === "ul" || tag === "ol") {
      const isOl = tag === "ol";
      const childUlDepth = isOl ? ulDepth : ulDepth + 1;
      const childOlDepth = isOl ? olDepth + 1 : olDepth;
      let index = 0;
      for (const child of Array.from(el.children)) {
        if (child.tagName.toLowerCase() !== "li") continue;
        // Lexical wraps nested lists in an empty <li class="nz-li-nested">
        // - skip its marker and descend into the inner list.
        if (child.classList.contains("nz-li-nested")) {
          walk(child, childUlDepth, childOlDepth);
          continue;
        }
        index++;
        if (out.length > 0 && !endsWithNewline()) out.push("\n");
        const totalDepth = ulDepth + olDepth;
        const indent = "  ".repeat(totalDepth);
        const marker = isOl ? `${orderedMarker(index, olDepth)}. ` : `${unorderedMarker(ulDepth)} `;
        out.push(indent + marker);
        walk(child, childUlDepth, childOlDepth);
      }
      return;
    }

    if (tag === "li") {
      for (const child of Array.from(el.childNodes)) walk(child, ulDepth, olDepth);
      return;
    }

    if (tag === "br") {
      out.push("\n");
      return;
    }

    if (tag === "p" || tag === "div" || tag === "blockquote" || /^h[1-6]$/.test(tag)) {
      if (out.length > 0 && !endsWithNewline()) out.push("\n");
      // Preserve paragraph indent (set via Tab on non-list blocks). Lexical
      // renders __indent as inline padding-inline-start; mirror it as a
      // tab prefix so the structure survives plain-text paste.
      const indentLevel = readParagraphIndent(el);
      if (indentLevel > 0) out.push("\t".repeat(indentLevel));
      for (const child of Array.from(el.childNodes)) walk(child, ulDepth, olDepth);
      if (!endsWithNewline()) out.push("\n");
      return;
    }

    for (const child of Array.from(el.childNodes)) walk(child, ulDepth, olDepth);
  };

  walk(root, 0, 0);
  return out.join("").replace(/\n+$/, "");
}

function orderedMarker(index: number, depth: number): string {
  // Cycle: depth 0 → 1, 2, 3; depth 1 → a, b, c; depth 2 → i, ii, iii; repeat.
  const style = depth % 3;
  if (style === 1) return toAlpha(index);
  if (style === 2) return toRoman(index);
  return String(index);
}

function unorderedMarker(depth: number): string {
  // Cycle: • ◦ ▪
  const style = depth % 3;
  if (style === 1) return "◦";
  if (style === 2) return "▪";
  return "•";
}

function toAlpha(n: number): string {
  // 1 → a, 26 → z, 27 → aa, …
  let s = "";
  let x = n;
  while (x > 0) {
    const rem = (x - 1) % 26;
    s = String.fromCharCode(97 + rem) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s || "a";
}

function toRoman(n: number): string {
  if (n <= 0) return String(n);
  const pairs: [number, string][] = [
    [1000, "m"],
    [900, "cm"],
    [500, "d"],
    [400, "cd"],
    [100, "c"],
    [90, "xc"],
    [50, "l"],
    [40, "xl"],
    [10, "x"],
    [9, "ix"],
    [5, "v"],
    [4, "iv"],
    [1, "i"],
  ];
  let x = n;
  let s = "";
  for (const [v, sym] of pairs) {
    while (x >= v) {
      s += sym;
      x -= v;
    }
  }
  return s;
}

function readParagraphIndent(el: HTMLElement): number {
  // Lexical exposes __indent both as inline padding and as a data attribute
  // on serialized output. Probe both, fall back to 0.
  const data = el.getAttribute("data-indent");
  if (data) {
    const n = Number.parseInt(data, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const padding = el.style.paddingInlineStart || el.style.paddingLeft;
  if (padding?.endsWith("px")) {
    const px = Number.parseFloat(padding);
    if (Number.isFinite(px) && px > 0) return Math.round(px / 40);
  }
  return 0;
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

export type LoadEditorStateResult =
  | { ok: true }
  | { ok: false; reason: "empty" }
  | { ok: false; reason: "parse_error"; error: unknown };

/**
 * Load a serialized Lexical state into an editor.
 *
 * IMPORTANT: This used to swallow parse errors silently and leave the editor
 * blank. That was a data-loss bug - the next save in the pipeline would
 * overwrite the on-disk `content_json` with an empty root paragraph because
 * the editor "looked" empty. The caller now receives a typed result and is
 * expected to put the editor into a read-only recovery state on `parse_error`,
 * which the save pipeline must respect (no overwrite of broken-but-on-disk
 * content).
 */
export function loadEditorStateFromJSON(
  editor: LexicalEditor,
  json: string,
): LoadEditorStateResult {
  if (!json || json === "{}" || json.trim().length === 0) {
    return { ok: false, reason: "empty" };
  }
  try {
    const parsed = editor.parseEditorState(json);
    editor.setEditorState(parsed);
    return { ok: true };
  } catch (e) {
    console.error("[Lexical] failed to parse editor state - editor in recovery mode", e);
    return { ok: false, reason: "parse_error", error: e };
  }
}
