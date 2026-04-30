/**
 * Pure tree operations for the split-pane layout. Every op returns a new
 * tree (or unchanged ref if nothing changed) - the store wraps these and
 * pushes the result through `setState`. Keeping these pure means we can
 * unit-test them without touching SolidJS or the DOM.
 *
 * Invariants the operations preserve:
 * - Each `SplitNode` has ≥ 2 children. Single-child splits are collapsed
 *   by `normalize`.
 * - Adjacent splits with the same direction are flattened by `normalize`,
 *   so `[A | [B | C]]` becomes `[A | B | C]`. Keeps the user's mental
 *   model linear when they keep splitting in the same direction.
 * - `sizes.length === children.length` and the array sums to ~1.0.
 * - All `id` strings (pane + split) are globally unique within the tree.
 */

export type PaneId = string;
export type SplitId = string;

export type LeafPane = {
  kind: "pane";
  id: PaneId;
  noteId: string | null;
};

export type SplitNode = {
  kind: "split";
  id: SplitId;
  direction: "row" | "column"; // row = horizontal stack (vertical divider), column = vertical stack
  children: LayoutNode[];
  sizes: number[];
};

export type LayoutNode = LeafPane | SplitNode;

export type Side = "left" | "right" | "top" | "bottom";

export const MIN_PANE_FRACTION = 0.15;

let idCounter = 0;
function uid(prefix: string): string {
  // crypto.randomUUID is overkill for in-memory IDs that don't cross processes.
  // Counter + random suffix is unique-enough and stable across hot reloads.
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

export function newPane(noteId: string | null = null): LeafPane {
  return { kind: "pane", id: uid("p"), noteId };
}

export function newSplit(
  direction: "row" | "column",
  children: LayoutNode[],
  sizes?: number[],
): SplitNode {
  const eq = 1 / children.length;
  return {
    kind: "split",
    id: uid("s"),
    direction,
    children,
    sizes: sizes ?? children.map(() => eq),
  };
}

export function collectLeaves(node: LayoutNode): LeafPane[] {
  if (node.kind === "pane") return [node];
  const out: LeafPane[] = [];
  for (const c of node.children) out.push(...collectLeaves(c));
  return out;
}

export function paneCount(node: LayoutNode): number {
  return collectLeaves(node).length;
}

export function findPane(node: LayoutNode, paneId: PaneId): LeafPane | undefined {
  return collectLeaves(node).find((p) => p.id === paneId);
}

export function findPaneByNoteId(node: LayoutNode, noteId: string): LeafPane | undefined {
  return collectLeaves(node).find((p) => p.noteId === noteId);
}

/** Replace the noteId on a single pane. Returns a new tree (structural sharing
 *  for unchanged subtrees). */
export function replacePaneNote(
  node: LayoutNode,
  paneId: PaneId,
  noteId: string | null,
): LayoutNode {
  if (node.kind === "pane") {
    if (node.id !== paneId) return node;
    if (node.noteId === noteId) return node;
    return { ...node, noteId };
  }
  let changed = false;
  const newChildren = node.children.map((c) => {
    const next = replacePaneNote(c, paneId, noteId);
    if (next !== c) changed = true;
    return next;
  });
  if (!changed) return node;
  return { ...node, children: newChildren };
}

/** Wrap the target pane in a new split with `newPane` placed on `side`.
 *  Smart-flattens when the parent split's direction matches: instead of
 *  nesting, the new pane becomes a sibling. */
export function splitTreeAt(
  node: LayoutNode,
  targetPaneId: PaneId,
  side: Side,
  paneToInsert: LeafPane,
): LayoutNode {
  const dir: "row" | "column" = side === "left" || side === "right" ? "row" : "column";
  const insertAfter = side === "right" || side === "bottom";

  // Root is the target itself.
  if (node.kind === "pane") {
    if (node.id !== targetPaneId) return node;
    const children = insertAfter ? [node, paneToInsert] : [paneToInsert, node];
    return newSplit(dir, children);
  }

  // Walk children. If a direct child is the target AND our split has the
  // same direction, flatten in place rather than nesting a new split.
  const directIdx = node.children.findIndex((c) => c.kind === "pane" && c.id === targetPaneId);
  if (directIdx >= 0 && node.direction === dir) {
    const newChildren = [...node.children];
    const newSizes = [...node.sizes];
    const insertAt = insertAfter ? directIdx + 1 : directIdx;
    // Take half of the target's size and give it to the new pane.
    const targetSize = newSizes[directIdx];
    const half = targetSize / 2;
    newSizes[directIdx] = half;
    newChildren.splice(insertAt, 0, paneToInsert);
    newSizes.splice(insertAt, 0, half);
    return { ...node, children: newChildren, sizes: newSizes };
  }

  // Recurse.
  let changed = false;
  const newChildren = node.children.map((c) => {
    const next = splitTreeAt(c, targetPaneId, side, paneToInsert);
    if (next !== c) changed = true;
    return next;
  });
  if (!changed) return node;
  return { ...node, children: newChildren };
}

/** Remove a pane. Returns null if the removed pane was the only thing left.
 *  Splits that drop to a single child are collapsed. */
export function removePane(node: LayoutNode, paneId: PaneId): LayoutNode | null {
  if (node.kind === "pane") return node.id === paneId ? null : node;
  const keptChildren: LayoutNode[] = [];
  const keptSizes: number[] = [];
  for (let i = 0; i < node.children.length; i++) {
    const c = removePane(node.children[i], paneId);
    if (c) {
      keptChildren.push(c);
      keptSizes.push(node.sizes[i]);
    }
  }
  if (keptChildren.length === 0) return null;
  if (keptChildren.length === 1) return keptChildren[0];
  // Renormalize sizes so they sum to 1 again.
  return { ...node, children: keptChildren, sizes: renormalize(keptSizes) };
}

/** Flatten same-direction nested splits and collapse single-child splits.
 *  Idempotent. Run after any mutation that could leave the tree denormalized. */
export function normalize(node: LayoutNode): LayoutNode {
  if (node.kind === "pane") return node;
  // Recurse first.
  const normChildren = node.children.map(normalize);

  const flatChildren: LayoutNode[] = [];
  const flatSizes: number[] = [];
  for (let i = 0; i < normChildren.length; i++) {
    const c = normChildren[i];
    const s = node.sizes[i];
    if (c.kind === "split" && c.direction === node.direction) {
      // Flatten: distribute s across c's children proportionally.
      for (let j = 0; j < c.children.length; j++) {
        flatChildren.push(c.children[j]);
        flatSizes.push(s * c.sizes[j]);
      }
    } else {
      flatChildren.push(c);
      flatSizes.push(s);
    }
  }
  if (flatChildren.length === 1) return flatChildren[0];
  return { ...node, children: flatChildren, sizes: renormalize(flatSizes) };
}

/** Adjust the divider between two adjacent siblings of a split. `boundaryIdx`
 *  is the left/top child's index; `leftFraction` is its desired share of the
 *  *joint* space (children[boundaryIdx] + children[boundaryIdx+1]).
 *
 *  The drag UI only ever moves one boundary at a time, so this is the only
 *  resize op we need. Clamping happens locally to the joint space so neither
 *  side drops below MIN_PANE_FRACTION - except when the joint space itself is
 *  smaller than 2 × MIN (deeply nested splits), in which case both sides get
 *  half. The other split sizes don't need touching since the pair is closed. */
export function resizeBoundary(
  node: LayoutNode,
  splitId: SplitId,
  boundaryIdx: number,
  leftFraction: number,
): LayoutNode {
  if (node.kind === "pane") return node;
  if (node.id === splitId) {
    if (boundaryIdx < 0 || boundaryIdx >= node.children.length - 1) return node;
    const total = node.sizes[boundaryIdx] + node.sizes[boundaryIdx + 1];
    const minLeft = Math.min(MIN_PANE_FRACTION, total / 2);
    const maxLeft = total - minLeft;
    const newLeftAbs = Math.max(minLeft, Math.min(maxLeft, leftFraction * total));
    const newSizes = [...node.sizes];
    newSizes[boundaryIdx] = newLeftAbs;
    newSizes[boundaryIdx + 1] = total - newLeftAbs;
    return { ...node, sizes: newSizes };
  }
  let changed = false;
  const newChildren = node.children.map((c) => {
    const next = resizeBoundary(c, splitId, boundaryIdx, leftFraction);
    if (next !== c) changed = true;
    return next;
  });
  if (!changed) return node;
  return { ...node, children: newChildren };
}

function renormalize(sizes: number[]): number[] {
  const sum = sizes.reduce((s, x) => s + x, 0);
  if (sum <= 0) {
    const eq = 1 / sizes.length;
    return sizes.map(() => eq);
  }
  return sizes.map((s) => s / sum);
}

/** Drop noteId references that no longer exist. Used at restore-from-disk
 *  time to handle "this layout was saved when notes existed that have since
 *  been purged." Returns a new tree with affected panes set to noteId=null. */
export function reconcileWithExistingNotes(node: LayoutNode, validIds: Set<string>): LayoutNode {
  if (node.kind === "pane") {
    if (node.noteId && !validIds.has(node.noteId)) {
      return { ...node, noteId: null };
    }
    return node;
  }
  let changed = false;
  const newChildren = node.children.map((c) => {
    const next = reconcileWithExistingNotes(c, validIds);
    if (next !== c) changed = true;
    return next;
  });
  if (!changed) return node;
  return { ...node, children: newChildren };
}
