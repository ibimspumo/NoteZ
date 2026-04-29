import { describe, expect, it } from "vitest";
import { LRU } from "./lru";

describe("LRU", () => {
  it("evicts the oldest entry when over cap", () => {
    const c = new LRU<string, number>(2);
    c.set("a", 1);
    c.set("b", 2);
    c.set("c", 3);
    expect(c.has("a")).toBe(false);
    expect(c.get("b")).toBe(2);
    expect(c.get("c")).toBe(3);
  });

  it("re-inserts on get to mark recency", () => {
    const c = new LRU<string, number>(2);
    c.set("a", 1);
    c.set("b", 2);
    // touch a, making b the LRU
    c.get("a");
    c.set("c", 3);
    expect(c.has("b")).toBe(false);
    expect(c.get("a")).toBe(1);
    expect(c.get("c")).toBe(3);
  });

  it("re-inserts on set to overwrite + move-to-end", () => {
    const c = new LRU<string, number>(2);
    c.set("a", 1);
    c.set("b", 2);
    c.set("a", 11);
    c.set("c", 3);
    // 'a' was just refreshed, so 'b' is the eviction target.
    expect(c.has("b")).toBe(false);
    expect(c.get("a")).toBe(11);
  });

  it("rejects non-positive caps", () => {
    expect(() => new LRU(0)).toThrow();
    expect(() => new LRU(-1)).toThrow();
  });

  it("delete returns previous-presence boolean", () => {
    const c = new LRU<string, number>(4);
    c.set("a", 1);
    expect(c.delete("a")).toBe(true);
    expect(c.delete("a")).toBe(false);
  });
});
