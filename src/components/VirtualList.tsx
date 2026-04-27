import {
  For,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  type JSX,
  type Component,
} from "solid-js";

/**
 * Fixed-row-height windowed list. Renders only the visible window plus an
 * overscan buffer, so DOM size is O(viewport) regardless of the underlying
 * collection size — the sidebar stays at ~30 row nodes whether the user has
 * 100 or 200 million notes.
 *
 * The scroll container is the component's root: it owns its own overflow.
 * Place it inside a flex parent with `min-height: 0`.
 */
type Props = {
  rowHeight: number;
  count: number;
  /** Render a row by index. Returned element gets absolute-positioned by the list. */
  renderRow: (index: number) => JSX.Element;
  /** Extra rows to render above and below the viewport (default 6). */
  overscan?: number;
  /** Called when the user scrolls within `loadMoreOffset` of the bottom and `hasMore` is true. */
  hasMore?: boolean;
  onLoadMore?: () => void;
  /** Distance from bottom (in px) to fire `onLoadMore`. Default 8 row heights. */
  loadMoreOffsetPx?: number;
  /** Extra class on the scroll container. */
  class?: string;
};

export const VirtualList: Component<Props> = (props) => {
  let containerRef!: HTMLDivElement;
  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewportHeight, setViewportHeight] = createSignal(0);

  onMount(() => {
    setViewportHeight(containerRef.clientHeight);
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setViewportHeight(entry.contentRect.height);
      }
    });
    ro.observe(containerRef);
    onCleanup(() => ro.disconnect());
  });

  const overscan = () => props.overscan ?? 6;

  const startIndex = createMemo(() => {
    const idx = Math.floor(scrollTop() / props.rowHeight) - overscan();
    return Math.max(0, idx);
  });

  const endIndex = createMemo(() => {
    const idx =
      Math.ceil((scrollTop() + viewportHeight()) / props.rowHeight) + overscan();
    return Math.min(props.count, idx);
  });

  const indices = createMemo(() => {
    const out: number[] = [];
    for (let i = startIndex(); i < endIndex(); i++) out.push(i);
    return out;
  });

  // loadMore trigger — runs at most one outstanding call at a time. The flag
  // resets only after the call resolves (success or failure), so a flaky load
  // can't permanently wedge pagination: once the inner promise settles, the
  // next scroll into the trigger zone fires another attempt.
  let loadMoreInFlight = false;
  createEffect(() => {
    if (!props.hasMore || !props.onLoadMore) return;
    if (loadMoreInFlight) return;
    if (viewportHeight() === 0) return; // not laid out yet — wait
    const totalHeight = props.count * props.rowHeight;
    const distFromBottom = totalHeight - (scrollTop() + viewportHeight());
    const offset = props.loadMoreOffsetPx ?? props.rowHeight * 8;
    if (distFromBottom >= offset) return;

    loadMoreInFlight = true;
    Promise.resolve()
      .then(() => props.onLoadMore?.())
      .catch((e) => {
        console.error("[VirtualList] loadMore failed:", e);
      })
      .finally(() => {
        loadMoreInFlight = false;
      });
  });

  return (
    <div
      ref={containerRef}
      class={`nz-vlist ${props.class ?? ""}`}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
    >
      <div
        class="nz-vlist-spacer"
        style={{ height: `${props.count * props.rowHeight}px` }}
      >
        <For each={indices()}>
          {(i) => (
            <div
              class="nz-vlist-row"
              style={{
                transform: `translateY(${i * props.rowHeight}px)`,
                height: `${props.rowHeight}px`,
              }}
            >
              {props.renderRow(i)}
            </div>
          )}
        </For>
      </div>
    </div>
  );
};
