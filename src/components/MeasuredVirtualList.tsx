import {
  type Component,
  For,
  type JSX,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";

/**
 * Windowed list with content-driven, measured row heights.
 *
 * Designed for the 1M-row case (see CLAUDE.md "Performance budget"):
 *
 *  - Only the visible window + overscan is rendered. DOM stays at ~30 rows
 *    regardless of `count`.
 *  - Row heights are content-driven, not fixed. Each rendered row reports
 *    its real measured height via a single shared `ResizeObserver`. Until a
 *    row is measured, `estimateHeight(i)` is used so unseen rows still take
 *    up space proportional to their content.
 *  - Prefix sums (used to find "which row is at scrollTop?" and "where do I
 *    place row i?") live in a Fenwick tree (binary indexed tree). A single
 *    measured-height update is an O(log n) point operation; finding a row
 *    by offset is also O(log n) via Fenwick descent. The cost of measuring
 *    a row does not depend on n - we never rebuild offsets for a measurement.
 *  - Count changes (load-more, refresh) rebuild the tree in O(n) once. That
 *    is amortized across hundreds of subsequent measurements / scrolls and
 *    is fine even at 1M rows (~tens of ms, off the critical path).
 *  - Scroll anchoring: when measurements above the current viewport change
 *    the offsets, we adjust `scrollTop` by the delta so the user's visible
 *    content does not jump. This is what makes streaming measurements
 *    invisible to the user.
 */

type Props = {
  count: number;
  /** Height estimate used until a row is measured. */
  estimateHeight: (index: number) => number;
  /** Bump this number to invalidate all stored heights and re-estimate
   *  every row, including ones that were previously measured. Use when
   *  something outside the row data itself changed the layout - e.g. the
   *  sidebar density setting flipped from "compact" to "1 line", which
   *  changes the height of every row even though `count` is unchanged.
   *  Defaults to 0 (no rebuilds beyond count changes). */
  estimateVersion?: number;
  renderRow: (index: number) => JSX.Element;
  overscan?: number;
  hasMore?: boolean;
  onLoadMore?: () => void;
  /** Distance from bottom (px) to fire `onLoadMore`. Default 600px. */
  loadMoreOffsetPx?: number;
  class?: string;
  /** Receives the scroll container element on mount. Useful for callers
   *  that need to measure the available width (row-height probes). */
  ref?: (el: HTMLDivElement) => void;
};

export const MeasuredVirtualList: Component<Props> = (props) => {
  let containerRef!: HTMLDivElement;

  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewportHeight, setViewportHeight] = createSignal(0);
  // Bumped on every Fenwick mutation so memo dependents re-evaluate. We
  // keep mutable state outside Solid's reactive graph (the tree itself)
  // and use this single signal as the dependency, instead of trying to
  // wrap thousands of array slots reactively.
  const [revision, setRevision] = createSignal(0);

  const overscan = () => props.overscan ?? 6;

  // ─── Fenwick tree state ──────────────────────────────────────────────────
  // 1-indexed Fenwick storage of length count + 1. `heights[i]` is the
  // logical height (estimated or measured) for row i; `measured[i] === 1`
  // marks rows that have been measured at least once.
  let tree = new Float64Array(1);
  let heights = new Float64Array(0);
  let measured = new Uint8Array(0);
  let lastCount = 0;
  let lastEstimateVersion = -1;

  function fenwickUpdate(i: number, delta: number) {
    if (delta === 0) return;
    for (let x = i + 1; x < tree.length; x += x & -x) tree[x] += delta;
  }

  function fenwickPrefix(i: number): number {
    // Sum of heights[0..=i].
    let s = 0;
    for (let x = i + 1; x > 0; x -= x & -x) s += tree[x];
    return s;
  }

  function totalHeightSync(): number {
    if (lastCount === 0) return 0;
    return fenwickPrefix(lastCount - 1);
  }

  /** Largest i where prefixSum(i - 1) <= target. O(log n) Fenwick descent. */
  function fenwickFindIndex(target: number): number {
    const n = lastCount;
    if (n === 0) return 0;
    let i = 0;
    let bit = 1;
    while (bit << 1 <= n) bit <<= 1;
    let remaining = target;
    for (; bit > 0; bit >>= 1) {
      const next = i + bit;
      if (next <= n && tree[next] <= remaining) {
        i = next;
        remaining -= tree[next];
      }
    }
    return Math.min(i, n - 1);
  }

  function offsetOf(i: number): number {
    if (i <= 0) return 0;
    return fenwickPrefix(i - 1);
  }

  /** Build a Fenwick tree from `heights` in O(n) using the standard linear
   *  construction: every value propagates to its parent. */
  function buildFromHeights() {
    const n = heights.length;
    tree = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) tree[i + 1] = heights[i];
    for (let i = 1; i <= n; i++) {
      const parent = i + (i & -i);
      if (parent <= n) tree[parent] += tree[i];
    }
  }

  // ─── (Re)build for count or estimate-version changes ─────────────────────
  // Two triggers, both amortized-rare:
  //   - count changed (load-more, refresh): preserve existing heights and
  //     measurements for the overlap; estimate the appended tail.
  //   - estimateVersion bumped: previous measurements are stale (e.g. the
  //     sidebar density setting changed every row's layout). Reset all
  //     heights from `estimateHeight(i)` and clear the measured flags;
  //     the ResizeObserver will re-confirm visible rows shortly after.
  // Both branches keep the hot paths (per-measurement, per-scroll) at
  // O(log n) - we only eat the O(n) cost on these external triggers.
  createEffect(() => {
    const n = props.count;
    const ev = props.estimateVersion ?? 0;
    if (n === lastCount && ev === lastEstimateVersion) return;

    const versionChanged = ev !== lastEstimateVersion;
    const fullRebuild = versionChanged || lastCount === 0;

    const newHeights = new Float64Array(n);
    const newMeasured = new Uint8Array(n);

    if (!fullRebuild) {
      const overlap = Math.min(n, lastCount);
      for (let i = 0; i < overlap; i++) {
        newHeights[i] = heights[i];
        newMeasured[i] = measured[i];
      }
      for (let i = overlap; i < n; i++) {
        newHeights[i] = props.estimateHeight(i);
      }
    } else {
      for (let i = 0; i < n; i++) {
        newHeights[i] = props.estimateHeight(i);
      }
      // measured[] left at zero — stale measurements get re-confirmed by
      // the ResizeObserver as the user re-encounters each row.
    }

    heights = newHeights;
    measured = newMeasured;
    buildFromHeights();
    lastCount = n;
    lastEstimateVersion = ev;
    setRevision((r) => r + 1);
  });

  // ─── Measurement application ─────────────────────────────────────────────
  // Created at component setup (not in onMount) because Solid fires `ref`
  // callbacks during JSX evaluation, BEFORE onMount runs - if `ro` were
  // initialized later, the first batch of rows would never be observed.
  // ResizeObserver itself doesn't need the DOM to exist at construction.
  const ro = new ResizeObserver((entries) => {
    for (const e of entries) {
      const el = e.target as HTMLElement;
      const idxStr = el.dataset.vlistIndex;
      if (!idxStr) continue;
      const i = Number(idxStr);
      const h = el.offsetHeight || e.contentRect.height;
      applyMeasurement(i, h);
    }
  });

  function applyMeasurement(i: number, h: number) {
    if (i < 0 || i >= lastCount) return;
    const prev = heights[i];
    if (prev === h && measured[i] === 1) return;

    const delta = h - prev;
    heights[i] = h;
    measured[i] = 1;
    if (delta !== 0) {
      fenwickUpdate(i, delta);
      // Scroll anchoring: if the changed row sits above the current scroll
      // position, bump scrollTop by `delta` so the visible content does not
      // jump. Rows inside the viewport will visually shift by `delta`, but
      // since they were rendered against their own estimate first, that
      // delta is typically small (estimate vs reality).
      const rowEnd = offsetOf(i) + h;
      if (rowEnd <= scrollTop()) {
        containerRef.scrollTop = containerRef.scrollTop + delta;
      }
      setRevision((r) => r + 1);
    }
  }

  onMount(() => {
    setViewportHeight(containerRef.clientHeight);

    const viewportObserver = new ResizeObserver((entries) => {
      for (const e of entries) setViewportHeight(e.contentRect.height);
    });
    viewportObserver.observe(containerRef);

    onCleanup(() => {
      viewportObserver.disconnect();
      ro.disconnect();
    });
  });

  // ─── Window calculation ──────────────────────────────────────────────────
  const startIndex = createMemo(() => {
    revision();
    if (lastCount === 0) return 0;
    return Math.max(0, fenwickFindIndex(scrollTop()) - overscan());
  });

  const endIndex = createMemo(() => {
    revision();
    if (lastCount === 0) return 0;
    const target = scrollTop() + viewportHeight();
    return Math.min(lastCount, fenwickFindIndex(target) + 1 + overscan());
  });

  const indices = createMemo(() => {
    const out: number[] = [];
    for (let i = startIndex(); i < endIndex(); i++) out.push(i);
    return out;
  });

  const totalHeight = createMemo(() => {
    revision();
    return totalHeightSync();
  });

  // ─── load-more ──────────────────────────────────────────────────────────
  let loadMoreInFlight = false;
  createEffect(() => {
    revision();
    if (!props.hasMore || !props.onLoadMore) return;
    if (loadMoreInFlight) return;
    if (viewportHeight() === 0) return;
    const offset = props.loadMoreOffsetPx ?? 600;
    const distFromBottom = totalHeight() - (scrollTop() + viewportHeight());
    if (distFromBottom >= offset) return;
    loadMoreInFlight = true;
    Promise.resolve()
      .then(() => props.onLoadMore?.())
      .catch((e) => console.error("[MeasuredVirtualList] loadMore failed:", e))
      .finally(() => {
        loadMoreInFlight = false;
      });
  });

  return (
    <div
      ref={(el) => {
        containerRef = el;
        props.ref?.(el);
      }}
      class={`nz-mvlist ${props.class ?? ""}`}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
    >
      <div class="nz-mvlist-spacer" style={{ height: `${totalHeight()}px` }}>
        <For each={indices()}>
          {(i) => {
            // Transform must re-evaluate when the Fenwick tree mutates -
            // a row above us getting taller shifts our absolute position.
            // We don't read from the tree reactively (it's mutable state),
            // so we explicitly track `revision()` here. Without this memo,
            // already-rendered rows keep their original mount-time
            // translateY and would overlap on resize.
            const transform = createMemo(() => {
              revision();
              return `translateY(${offsetOf(i)}px)`;
            });
            return (
              <div
                class="nz-mvlist-row"
                data-vlist-index={i}
                style={{ transform: transform() }}
                ref={(el) => {
                  ro.observe(el);
                  onCleanup(() => ro.unobserve(el));
                }}
              >
                {props.renderRow(i)}
              </div>
            );
          }}
        </For>
      </div>
    </div>
  );
};
