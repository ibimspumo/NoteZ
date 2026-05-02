/**
 * Tiny LRU cache backed by an insertion-ordered Map.
 *
 * `Map` preserves insertion order in all modern engines and is iterable in
 * order, so re-inserting on `get` is enough to make a hit "newest". We use it
 * for the per-note Lexical-state cache (50 entries) and the blurhash data-URL
 * cache (200 entries).
 *
 * Reasons for rolling our own instead of pulling a dep:
 *   - The semantics are 12 lines.
 *   - No transitive deps in the renderer bundle.
 *   - Easy to test in isolation.
 */

export class LRU<K, V> {
  private map = new Map<K, V>();

  constructor(private cap: number) {
    if (cap <= 0) throw new Error("LRU cap must be > 0");
  }

  /** O(1). Side effect: marks `k` as most-recently-used on hit. */
  get(k: K): V | undefined {
    const v = this.map.get(k);
    if (v === undefined) return undefined;
    // Move-to-end: delete + re-insert keeps Map's iteration order in sync
    // with recency. Cheaper than maintaining a parallel doubly-linked list
    // for cap sizes <= a few hundred.
    this.map.delete(k);
    this.map.set(k, v);
    return v;
  }

  /** O(1). Evicts the oldest entry when over cap. */
  set(k: K, v: V): void {
    if (this.map.has(k)) this.map.delete(k);
    this.map.set(k, v);
    if (this.map.size > this.cap) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }

  has(k: K): boolean {
    return this.map.has(k);
  }

  delete(k: K): boolean {
    return this.map.delete(k);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}
