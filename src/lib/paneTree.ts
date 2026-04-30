/**
 * Pure tree operations for the split-pane layout. Every op returns a new
 * tree (or unchanged ref if nothing changed) - the store wraps these and
 * pushes the result through `setState`. Keeping these pure means we can
 * unit-test them without touching SolidJS or the DOM.
 *
 * Each leaf pane carries its own array of tabs (browser-style). A pane is
 * never empty: even a "fresh" pane has one tab with `noteId: null` (the
 * empty-state picker). `activeTabIdx` always points at a valid index.
 *
 * Invariants the operations preserve:
 * - Each `SplitNode` has >= 2 children. Single-child splits are collapsed
 *   by `normalize`.
 * - Adjacent splits with the same direction are flattened by `normalize`,
 *   so `[A | [B | C]]` becomes `[A | B | C]`. Keeps the user's mental
 *   model linear when they keep splitting in the same direction.
 * - `sizes.length === children.length` and the array sums to ~1.0.
 * - Each `LeafPane.tabs` has length >= 1. `activeTabIdx` in [0, tabs.length).
 * - All `id` strings (pane + split + tab) are globally unique within the tree.
 */

export type PaneId = string;
export type SplitId = string;
export type TabId = string;

export type Tab = {
  id: TabId;
  noteId: string | null;
};

export type LeafPane = {
  kind: "pane";
  id: PaneId;
  tabs: Tab[];
  activeTabIdx: number;
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

export function newTab(noteId: string | null = null): Tab {
  return { id: uid("t"), noteId };
}

export function newPane(noteId: string | null = null): LeafPane {
  return { kind: "pane", id: uid("p"), tabs: [newTab(noteId)], activeTabIdx: 0 };
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

/** Active tab of a pane. The pane invariant guarantees at least one tab,
 *  and `activeTabIdx` is always in range. */
export function activeTab(pane: LeafPane): Tab {
  return pane.tabs[pane.activeTabIdx];
}

/** Active note id of a pane (or null if the active tab is empty). */
export function activeNoteId(pane: LeafPane): string | null {
  return activeTab(pane).noteId;
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

/** Locate which pane and tab a given noteId is open in (the same noteId is
 *  global-unique across the whole layout, so the first hit is the only hit). */
export function findTabByNoteId(
  node: LayoutNode,
  noteId: string,
): { pane: LeafPane; tabIdx: number } | undefined {
  for (const p of collectLeaves(node)) {
    const idx = p.tabs.findIndex((t) => t.noteId === noteId);
    if (idx >= 0) return { pane: p, tabIdx: idx };
  }
  return undefined;
}

/** Wrap the target pane in a new split with `paneToInsert` placed on `side`.
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

/** Drop noteId references that no longer exist. Tabs with an invalid noteId
 *  have their noteId nulled (so the empty picker shows up); the tab itself is
 *  preserved so the user's tab topology survives. */
export function reconcileWithExistingNotes(node: LayoutNode, validIds: Set<string>): LayoutNode {
  if (node.kind === "pane") {
    let changed = false;
    const nextTabs = node.tabs.map((t) => {
      if (t.noteId && !validIds.has(t.noteId)) {
        changed = true;
        return { ...t, noteId: null };
      }
      return t;
    });
    if (!changed) return node;
    return { ...node, tabs: nextTabs };
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

/** Migrate a layout that was persisted under the old `{ noteId }` shape into
 *  the new `{ tabs, activeTabIdx }` shape. Idempotent: tab-shaped panes are
 *  returned unchanged. The persisted blob is `unknown` because it crosses the
 *  serialization boundary. */
export function migrateLegacyLayout(node: unknown): LayoutNode {
  if (!node || typeof node !== "object") {
    // Defensive fallback - caller shouldn't reach this with valid input.
    return newPane(null);
  }
  const obj = node as Record<string, unknown>;
  if (obj.kind === "pane") {
    if (Array.isArray(obj.tabs)) {
      // Already new shape - validate the minimum invariants and pass through.
      const tabs = (obj.tabs as unknown[]).map((t) => {
        const tobj = t as Record<string, unknown>;
        return {
          id: typeof tobj.id === "string" ? tobj.id : uid("t"),
          noteId: typeof tobj.noteId === "string" ? tobj.noteId : null,
        };
      });
      const finalTabs = tabs.length > 0 ? tabs : [newTab(null)];
      const idx = typeof obj.activeTabIdx === "number" ? obj.activeTabIdx : 0;
      return {
        kind: "pane",
        id: typeof obj.id === "string" ? obj.id : uid("p"),
        tabs: finalTabs,
        activeTabIdx: Math.max(0, Math.min(finalTabs.length - 1, idx)),
      };
    }
    // Old shape: { kind: "pane", id, noteId }. Promote noteId to a single tab.
    const noteId = typeof obj.noteId === "string" ? obj.noteId : null;
    return {
      kind: "pane",
      id: typeof obj.id === "string" ? obj.id : uid("p"),
      tabs: [newTab(noteId)],
      activeTabIdx: 0,
    };
  }
  if (obj.kind === "split") {
    const children = Array.isArray(obj.children) ? obj.children : [];
    const sizes = Array.isArray(obj.sizes) ? (obj.sizes as number[]) : [];
    const migratedChildren = children.map(migrateLegacyLayout);
    const safeSizes =
      sizes.length === migratedChildren.length
        ? sizes
        : migratedChildren.map(() => 1 / Math.max(1, migratedChildren.length));
    return {
      kind: "split",
      id: typeof obj.id === "string" ? obj.id : uid("s"),
      direction: obj.direction === "column" ? "column" : "row",
      children: migratedChildren,
      sizes: renormalize(safeSizes),
    };
  }
  return newPane(null);
}
