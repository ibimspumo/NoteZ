import {
  $createRangeSelection,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  type LexicalEditor,
  type LexicalNode,
  type Point,
} from "lexical";

export type SerializedPoint = {
  // Index path from root → leaf. Stable across `setEditorState` (node keys are
  // not - they're regenerated when state is reloaded from JSON).
  path: number[];
  offset: number;
  type: "text" | "element";
};

export type SerializedSelection = {
  anchor: SerializedPoint;
  focus: SerializedPoint;
};

function pathFromPoint(point: Point): SerializedPoint | null {
  const path: number[] = [];
  let node: LexicalNode | null = point.getNode();
  while (node) {
    const parent: LexicalNode | null = node.getParent();
    if (!parent) break;
    path.unshift(node.getIndexWithinParent());
    node = parent;
  }
  return { path, offset: point.offset, type: point.type };
}

function nodeFromPath(path: number[]): LexicalNode | null {
  let cur: LexicalNode = $getRoot();
  for (const i of path) {
    if (!$isElementNode(cur)) return null;
    const child = cur.getChildAtIndex(i);
    if (!child) return null;
    cur = child;
  }
  return cur;
}

function maxOffsetFor(node: LexicalNode, type: "text" | "element"): number {
  if (type === "text" && $isTextNode(node)) return node.getTextContentSize();
  if (type === "element" && $isElementNode(node)) return node.getChildrenSize();
  return 0;
}

export function captureSelection(editor: LexicalEditor): SerializedSelection | null {
  let result: SerializedSelection | null = null;
  editor.getEditorState().read(() => {
    const sel = $getSelection();
    if (!$isRangeSelection(sel)) return;
    const a = pathFromPoint(sel.anchor);
    const f = pathFromPoint(sel.focus);
    if (!a || !f) return;
    result = { anchor: a, focus: f };
  });
  return result;
}

export function restoreSelection(editor: LexicalEditor, sel: SerializedSelection): void {
  editor.update(
    () => {
      const aNode = nodeFromPath(sel.anchor.path);
      const fNode = nodeFromPath(sel.focus.path);
      if (!aNode || !fNode) return;
      // Type may have shifted (e.g. paragraph that used to hold text is now empty).
      // Clamp the type to what the node actually supports, and clamp offset too.
      const aType: "text" | "element" =
        sel.anchor.type === "text" && !$isTextNode(aNode) ? "element" : sel.anchor.type;
      const fType: "text" | "element" =
        sel.focus.type === "text" && !$isTextNode(fNode) ? "element" : sel.focus.type;
      const range = $createRangeSelection();
      range.anchor.set(
        aNode.getKey(),
        Math.min(sel.anchor.offset, maxOffsetFor(aNode, aType)),
        aType,
      );
      range.focus.set(
        fNode.getKey(),
        Math.min(sel.focus.offset, maxOffsetFor(fNode, fType)),
        fType,
      );
      $setSelection(range);
    },
    { discrete: true, tag: "history-merge" },
  );
}
