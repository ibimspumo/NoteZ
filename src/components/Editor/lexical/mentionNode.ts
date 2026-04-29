import {
  $applyNodeReplacement,
  type EditorConfig,
  ElementNode,
  type LexicalNode,
  type NodeKey,
  type RangeSelection,
  type SerializedElementNode,
  type Spread,
} from "lexical";

export type SerializedMentionNode = Spread<
  {
    noteId: string;
    title: string;
  },
  SerializedElementNode
>;

export class MentionNode extends ElementNode {
  __noteId: string;
  __title: string;

  static getType(): string {
    return "mention";
  }

  static clone(node: MentionNode): MentionNode {
    return new MentionNode(node.__noteId, node.__title, node.__key);
  }

  constructor(noteId: string, title: string, key?: NodeKey) {
    super(key);
    this.__noteId = noteId;
    this.__title = title;
  }

  getNoteId(): string {
    return this.__noteId;
  }

  getTitle(): string {
    return this.__title;
  }

  setNoteId(id: string) {
    const writable = this.getWritable();
    writable.__noteId = id;
  }

  setTitle(title: string) {
    const writable = this.getWritable();
    writable.__title = title;
  }

  createDOM(_config: EditorConfig): HTMLElement {
    const el = document.createElement("a");
    el.setAttribute("data-note-id", this.__noteId);
    el.setAttribute("data-lexical-mention", "true");
    el.setAttribute("href", `notez://note/${this.__noteId}`);
    el.setAttribute("title", `@${this.__title}`);
    el.className = "nz-mention";
    el.contentEditable = "false";
    return el;
  }

  updateDOM(prev: MentionNode, dom: HTMLElement, _config: EditorConfig): boolean {
    if (prev.__noteId !== this.__noteId) {
      dom.setAttribute("data-note-id", this.__noteId);
      dom.setAttribute("href", `notez://note/${this.__noteId}`);
    }
    if (prev.__title !== this.__title) {
      dom.setAttribute("title", `@${this.__title}`);
    }
    return false;
  }

  isInline(): boolean {
    return true;
  }

  isToken(): boolean {
    return true;
  }

  canBeEmpty(): boolean {
    return false;
  }

  canInsertTextBefore(): boolean {
    return false;
  }

  canInsertTextAfter(): boolean {
    return true;
  }

  insertNewAfter(_selection: RangeSelection, _restoreSelection?: boolean): null {
    return null;
  }

  exportJSON(): SerializedMentionNode {
    return {
      ...super.exportJSON(),
      type: "mention",
      version: 1,
      noteId: this.__noteId,
      title: this.__title,
    };
  }

  static importJSON(serialized: SerializedMentionNode): MentionNode {
    const node = $createMentionNode(serialized.noteId, serialized.title);
    return node;
  }

  getTextContent(): string {
    return `@${this.__title}`;
  }

  extractWithChild(): boolean {
    return true;
  }
}

export function $createMentionNode(noteId: string, title: string): MentionNode {
  const node = new MentionNode(noteId, title);
  return $applyNodeReplacement(node);
}

export function $isMentionNode(node: LexicalNode | null | undefined): node is MentionNode {
  return node instanceof MentionNode;
}

export type MentionClickOpts = {
  /** True when the user held the platform mod key (⌘ on mac, Ctrl elsewhere)
   *  - request to open the note in a new right-split pane instead of the
   *  active pane, mirroring ⌘D. */
  split: boolean;
};

export function attachMentionClickHandler(
  rootEl: HTMLElement,
  onClick: (noteId: string, opts: MentionClickOpts) => void,
): () => void {
  const handler = (e: MouseEvent) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    const mentionEl = target.closest("[data-lexical-mention='true']") as HTMLElement | null;
    if (!mentionEl) return;
    const noteId = mentionEl.getAttribute("data-note-id");
    if (!noteId) return;
    e.preventDefault();
    e.stopPropagation();
    onClick(noteId, { split: e.metaKey || e.ctrlKey });
  };
  rootEl.addEventListener("click", handler);
  return () => rootEl.removeEventListener("click", handler);
}

// `collectMentionTargets` lives in `editorRefs.ts` now - it's backed by an
// incremental mutation listener instead of a full node-map scan, so saves on
// huge notes don't pay an O(n) traversal cost.
export { collectMentionTargets } from "./editorRefs";
