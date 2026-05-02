import { describe, expect, it } from "vitest";
import { computeLineDiff, diffStats } from "./diff";

describe("computeLineDiff", () => {
  it("returns context-only diff for identical input", () => {
    const lines = computeLineDiff("hello\nworld", "hello\nworld");
    expect(lines.every((l) => l.kind === "context")).toBe(true);
    expect(diffStats(lines)).toEqual({ added: 0, removed: 0 });
  });

  it("flags added lines as add", () => {
    const lines = computeLineDiff("a\nb", "a\nb\nc");
    expect(diffStats(lines)).toEqual({ added: 1, removed: 0 });
    expect(lines.at(-1)).toMatchObject({ kind: "add", text: "c" });
  });

  it("flags removed lines as remove", () => {
    const lines = computeLineDiff("a\nb\nc", "a\nc");
    expect(diffStats(lines)).toEqual({ added: 0, removed: 1 });
    expect(lines.find((l) => l.kind === "remove")).toMatchObject({ text: "b" });
  });

  it("pairs single-line edits with word-level overlay", () => {
    const lines = computeLineDiff("hello world", "hello there");
    const remove = lines.find((l) => l.kind === "remove");
    const add = lines.find((l) => l.kind === "add");
    expect(remove?.words).toBeDefined();
    expect(add?.words).toBeDefined();
    // 'hello' should appear as 'same' on both sides.
    expect(remove?.words?.some((w) => w.kind === "same" && w.text.includes("hello"))).toBe(true);
    expect(add?.words?.some((w) => w.kind === "same" && w.text.includes("hello"))).toBe(true);
    // 'world' should be removed; 'there' should be added.
    expect(remove?.words?.some((w) => w.kind === "remove" && w.text.includes("world"))).toBe(true);
    expect(add?.words?.some((w) => w.kind === "add" && w.text.includes("there"))).toBe(true);
  });

  it("does NOT word-pair multi-line replacements", () => {
    const lines = computeLineDiff("a\nb", "x\ny");
    const remove = lines.find((l) => l.kind === "remove");
    // No word-overlay because the block is 2 lines on each side.
    expect(remove?.words).toBeUndefined();
  });

  it("handles trailing-newline asymmetry without spurious empty line", () => {
    const lines = computeLineDiff("a\nb\n", "a\nb\nc\n");
    expect(diffStats(lines)).toEqual({ added: 1, removed: 0 });
    // Last add should be 'c', not '' (trailing-newline artifact).
    const adds = lines.filter((l) => l.kind === "add");
    expect(adds).toHaveLength(1);
    expect(adds[0].text).toBe("c");
  });

  it("handles empty input on either side", () => {
    expect(diffStats(computeLineDiff("", "hello"))).toEqual({ added: 1, removed: 0 });
    expect(diffStats(computeLineDiff("hello", ""))).toEqual({ added: 0, removed: 1 });
    expect(diffStats(computeLineDiff("", ""))).toEqual({ added: 0, removed: 0 });
  });
});
