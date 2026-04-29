import { describe, expect, it } from "vitest";
import {
  type LayoutNode,
  type LeafPane,
  collectLeaves,
  findPane,
  findPaneByNoteId,
  newPane,
  newSplit,
  normalize,
  paneCount,
  reconcileWithExistingNotes,
  removePane,
  replacePaneNote,
  resizeBoundary,
  splitTreeAt,
} from "./paneTree";

const sumSizes = (n: LayoutNode): boolean => {
  if (n.kind === "pane") return true;
  const s = n.sizes.reduce((a, b) => a + b, 0);
  if (Math.abs(s - 1) > 1e-9) return false;
  if (n.sizes.length !== n.children.length) return false;
  return n.children.every(sumSizes);
};

describe("paneTree", () => {
  it("newPane / newSplit produce valid nodes", () => {
    const p = newPane("note-1");
    expect(p.kind).toBe("pane");
    expect(p.noteId).toBe("note-1");
    const split = newSplit("row", [newPane(), newPane()]);
    expect(split.children).toHaveLength(2);
    expect(split.sizes).toEqual([0.5, 0.5]);
    expect(sumSizes(split)).toBe(true);
  });

  it("splitTreeAt on a root pane wraps it in a split", () => {
    const root: LeafPane = newPane("a");
    const inserted = newPane("b");
    const next = splitTreeAt(root, root.id, "right", inserted);
    expect(next.kind).toBe("split");
    if (next.kind !== "split") return;
    expect(next.direction).toBe("row");
    expect(next.children).toHaveLength(2);
    expect((next.children[0] as LeafPane).noteId).toBe("a");
    expect((next.children[1] as LeafPane).noteId).toBe("b");
    expect(sumSizes(next)).toBe(true);
  });

  it("splitTreeAt with side=left puts the inserted pane first", () => {
    const root: LeafPane = newPane("a");
    const inserted = newPane("b");
    const next = splitTreeAt(root, root.id, "left", inserted);
    if (next.kind !== "split") throw new Error();
    expect((next.children[0] as LeafPane).noteId).toBe("b");
    expect((next.children[1] as LeafPane).noteId).toBe("a");
  });

  it("splitTreeAt flattens when parent split has the same direction", () => {
    const a = newPane("a");
    const b = newPane("b");
    const root = newSplit("row", [a, b]);
    const c = newPane("c");
    const next = splitTreeAt(root, b.id, "right", c);
    if (next.kind !== "split") throw new Error();
    expect(next.children).toHaveLength(3);
    expect((next.children[2] as LeafPane).noteId).toBe("c");
    // b had 0.5, gets halved → 0.25 each
    expect(next.sizes[1]).toBeCloseTo(0.25);
    expect(next.sizes[2]).toBeCloseTo(0.25);
    expect(sumSizes(next)).toBe(true);
  });

  it("splitTreeAt nests when direction is perpendicular", () => {
    const a = newPane("a");
    const b = newPane("b");
    const root = newSplit("row", [a, b]);
    const c = newPane("c");
    // splitting b downward: should create a column-split inside the row.
    const next = splitTreeAt(root, b.id, "bottom", c);
    if (next.kind !== "split") throw new Error();
    expect(next.children).toHaveLength(2);
    expect(next.children[1].kind).toBe("split");
    if (next.children[1].kind !== "split") return;
    expect(next.children[1].direction).toBe("column");
  });

  it("removePane drops the pane and renormalizes sizes", () => {
    const a = newPane("a");
    const b = newPane("b");
    const c = newPane("c");
    const root = newSplit("row", [a, b, c]);
    const next = removePane(root, b.id);
    expect(next).not.toBeNull();
    if (!next || next.kind !== "split") throw new Error();
    expect(next.children).toHaveLength(2);
    expect(sumSizes(next)).toBe(true);
  });

  it("removePane collapses single-child splits", () => {
    const a = newPane("a");
    const b = newPane("b");
    const root = newSplit("row", [a, b]);
    const next = removePane(root, a.id);
    expect(next?.kind).toBe("pane");
    expect((next as LeafPane).noteId).toBe("b");
  });

  it("removePane returns null when removing the only pane", () => {
    const a = newPane("a");
    expect(removePane(a, a.id)).toBeNull();
  });

  it("normalize flattens nested splits with the same direction", () => {
    const a = newPane("a");
    const b = newPane("b");
    const c = newPane("c");
    const inner = newSplit("row", [b, c], [0.4, 0.6]);
    const outer = newSplit("row", [a, inner], [0.5, 0.5]);
    const next = normalize(outer);
    if (next.kind !== "split") throw new Error();
    expect(next.children).toHaveLength(3);
    expect(next.children.every((ch) => ch.kind === "pane")).toBe(true);
    // a kept 0.5; b/c had 0.4/0.6 inside an outer-half → 0.2/0.3
    expect(next.sizes[0]).toBeCloseTo(0.5);
    expect(next.sizes[1]).toBeCloseTo(0.2);
    expect(next.sizes[2]).toBeCloseTo(0.3);
    expect(sumSizes(next)).toBe(true);
  });

  it("normalize preserves perpendicular nested splits", () => {
    const a = newPane("a");
    const b = newPane("b");
    const c = newPane("c");
    const inner = newSplit("column", [b, c]);
    const outer = newSplit("row", [a, inner]);
    const next = normalize(outer);
    if (next.kind !== "split") throw new Error();
    expect(next.children[1].kind).toBe("split");
  });

  it("resizeBoundary clamps to MIN_PANE_FRACTION on both sides", () => {
    const a = newPane("a");
    const b = newPane("b");
    const root = newSplit("row", [a, b]);
    const tooSmall = resizeBoundary(root, root.id, 0, 0.02);
    if (tooSmall.kind !== "split") throw new Error();
    expect(tooSmall.sizes[0]).toBeGreaterThanOrEqual(0.15);
    expect(tooSmall.sizes[1]).toBeGreaterThanOrEqual(0.15);
    expect(sumSizes(tooSmall)).toBe(true);

    const tooBig = resizeBoundary(root, root.id, 0, 0.98);
    if (tooBig.kind !== "split") throw new Error();
    expect(tooBig.sizes[0]).toBeLessThanOrEqual(1 - 0.15);
    expect(sumSizes(tooBig)).toBe(true);
  });

  it("resizeBoundary keeps untouched siblings unchanged", () => {
    const a = newPane("a");
    const b = newPane("b");
    const c = newPane("c");
    const root = newSplit("row", [a, b, c], [0.4, 0.3, 0.3]);
    // Drag boundary between a and b; c's size shouldn't move.
    const next = resizeBoundary(root, root.id, 0, 0.6); // a wants 60% of (a+b)
    if (next.kind !== "split") throw new Error();
    expect(next.sizes[2]).toBeCloseTo(0.3);
    expect(next.sizes[0] + next.sizes[1]).toBeCloseTo(0.7);
    expect(sumSizes(next)).toBe(true);
  });

  it("findPane / findPaneByNoteId / paneCount / collectLeaves", () => {
    const a = newPane("note-a");
    const b = newPane("note-b");
    const c = newPane(null);
    const inner = newSplit("column", [b, c]);
    const root = newSplit("row", [a, inner]);
    expect(paneCount(root)).toBe(3);
    expect(collectLeaves(root)).toHaveLength(3);
    expect(findPane(root, b.id)?.noteId).toBe("note-b");
    expect(findPaneByNoteId(root, "note-a")?.id).toBe(a.id);
    expect(findPaneByNoteId(root, "note-missing")).toBeUndefined();
  });

  it("replacePaneNote returns same ref when nothing changes", () => {
    const a = newPane("note-a");
    const root = newSplit("row", [a, newPane("note-b")]);
    expect(replacePaneNote(root, a.id, "note-a")).toBe(root);
    const next = replacePaneNote(root, a.id, "note-x");
    expect(next).not.toBe(root);
    expect(findPane(next, a.id)?.noteId).toBe("note-x");
  });

  it("reconcileWithExistingNotes nulls panes whose note no longer exists", () => {
    const a = newPane("alive");
    const b = newPane("ghost");
    const root = newSplit("row", [a, b]);
    const valid = new Set(["alive"]);
    const next = reconcileWithExistingNotes(root, valid);
    expect(findPaneByNoteId(next, "alive")?.id).toBe(a.id);
    const ghostPane = collectLeaves(next).find((p) => p.id === b.id);
    expect(ghostPane?.noteId).toBeNull();
  });
});
