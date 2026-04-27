import {
  $createTextNode,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  COMMAND_PRIORITY_LOW,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  KEY_TAB_COMMAND,
  type LexicalEditor,
  type TextNode,
} from "lexical";
import { mergeRegister } from "@lexical/utils";
import { $createMentionNode } from "./mentionNode";

export type MentionMatch = {
  query: string;
  rangeStart: number;
  rangeEnd: number;
  textNodeKey: string;
  rect: DOMRect | null;
};

export type MentionAdapter = {
  onOpen: (match: MentionMatch) => void;
  onUpdate: (match: MentionMatch) => void;
  onClose: () => void;
  isOpen: () => boolean;
  navigate: (direction: "up" | "down") => void;
  confirmSelection: () => boolean;
};

export function registerMentionPlugin(
  editor: LexicalEditor,
  adapter: MentionAdapter,
): () => void {
  const closeIfOpen = () => {
    if (adapter.isOpen()) adapter.onClose();
  };

  const updateActiveMatch = () => {
    editor.getEditorState().read(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
        closeIfOpen();
        return;
      }
      const anchorNode = selection.anchor.getNode();
      if (!$isTextNode(anchorNode)) {
        closeIfOpen();
        return;
      }
      const text = (anchorNode as TextNode).getTextContent();
      const offset = selection.anchor.offset;

      const before = text.slice(0, offset);
      const atIdx = before.lastIndexOf("@");
      if (atIdx < 0) {
        closeIfOpen();
        return;
      }
      const between = before.slice(atIdx + 1);
      if (/[\s\n]/.test(between)) {
        closeIfOpen();
        return;
      }
      if (atIdx > 0) {
        const prevChar = before[atIdx - 1];
        if (prevChar && /[a-zA-Z0-9]/.test(prevChar)) {
          closeIfOpen();
          return;
        }
      }

      const rect = getCaretRect();
      const match: MentionMatch = {
        query: between,
        rangeStart: atIdx,
        rangeEnd: offset,
        textNodeKey: anchorNode.getKey(),
        rect,
      };
      if (!adapter.isOpen()) adapter.onOpen(match);
      else adapter.onUpdate(match);
    });
  };

  return mergeRegister(
    editor.registerUpdateListener(() => {
      updateActiveMatch();
    }),
    editor.registerCommand(
      KEY_ARROW_DOWN_COMMAND,
      () => {
        if (!adapter.isOpen()) return false;
        adapter.navigate("down");
        return true;
      },
      COMMAND_PRIORITY_LOW,
    ),
    editor.registerCommand(
      KEY_ARROW_UP_COMMAND,
      () => {
        if (!adapter.isOpen()) return false;
        adapter.navigate("up");
        return true;
      },
      COMMAND_PRIORITY_LOW,
    ),
    editor.registerCommand(
      KEY_ENTER_COMMAND,
      () => {
        if (!adapter.isOpen()) return false;
        return adapter.confirmSelection();
      },
      COMMAND_PRIORITY_LOW,
    ),
    editor.registerCommand(
      KEY_TAB_COMMAND,
      () => {
        if (!adapter.isOpen()) return false;
        return adapter.confirmSelection();
      },
      COMMAND_PRIORITY_LOW,
    ),
    editor.registerCommand(
      KEY_ESCAPE_COMMAND,
      () => {
        if (!adapter.isOpen()) return false;
        adapter.onClose();
        return true;
      },
      COMMAND_PRIORITY_LOW,
    ),
  );
}

export function insertMention(
  editor: LexicalEditor,
  match: MentionMatch,
  noteId: string,
  title: string,
) {
  editor.update(() => {
    const node = editor.getEditorState()._nodeMap.get(match.textNodeKey);
    if (!node || !$isTextNode(node)) return;

    const textNode = node as TextNode;
    const splitFirst = textNode.splitText(match.rangeStart, match.rangeEnd);
    let beforeAt: TextNode | undefined;
    let middle: TextNode | undefined;
    if (splitFirst.length === 3) {
      beforeAt = splitFirst[0];
      middle = splitFirst[1];
    } else if (splitFirst.length === 2) {
      if (match.rangeStart === 0) {
        middle = splitFirst[0];
      } else {
        beforeAt = splitFirst[0];
        middle = splitFirst[1];
      }
    } else {
      middle = splitFirst[0];
    }

    if (!middle) return;

    const mention = $createMentionNode(noteId, title);
    mention.append($createTextNode(`@${title}`));

    middle.replace(mention);
    const trailingSpace = $createTextNode(" ");
    mention.insertAfter(trailingSpace);
    trailingSpace.select(1, 1);
    void beforeAt;
  });
}

function getCaretRect(): DOMRect | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0).cloneRange();
  range.collapse(true);
  const rects = range.getClientRects();
  if (rects.length > 0) return rects[0];
  const r = range.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) {
    const containerEl = range.startContainer.nodeType === Node.ELEMENT_NODE
      ? (range.startContainer as HTMLElement)
      : (range.startContainer.parentElement as HTMLElement | null);
    return containerEl ? containerEl.getBoundingClientRect() : null;
  }
  return r;
}
