/**
 * Sidebar row-height probe.
 *
 * We don't *estimate* row heights for the sidebar list - we *measure* them
 * once via hidden DOM probes and then look up the exact value per note.
 *
 * Two facts about the sidebar make this work:
 *
 *   1. There are only three structurally different row layouts:
 *      title-only, title + 1 preview line, title + 2 preview lines.
 *      Their pixel heights are determined by font metrics and CSS, not by
 *      content - any two "1-line" rows are exactly the same height.
 *
 *   2. The number of preview lines a given note's text wraps to is
 *      determined by the text's rendered width vs the available width.
 *      We measure rendered width with a `<canvas>` 2D context (no layout,
 *      no DOM mutation, ~1µs per call) using the exact font of the
 *      `.nz-note-preview` class.
 *
 * Result: per-note row height is a deterministic lookup from
 *   (textWidth in px, availableWidth in px, maxLines) → bucket height.
 * No char-per-line guesswork.
 *
 * The probe re-runs when the sidebar width changes (collapse, manual
 * resize, font-size change). Callers should subscribe via `subscribe()` and
 * recompute their offsets on invalidation.
 */

type Kind = 0 | 1 | 2;

interface ProbedHeights {
  /** Heights in CSS px, indexed by line count (0 = title-only). */
  byKind: Record<Kind, number>;
  /** Pixel width available for preview text inside `.nz-note-item`. */
  previewContentWidth: number;
  /** Canvas font string built from the live computed style of `.nz-note-preview`. */
  previewFont: string;
}

type Listener = () => void;

const KIND_VALUES: ReadonlyArray<Kind> = [0, 1, 2];

let cached: ProbedHeights | null = null;
const listeners = new Set<Listener>();
let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let containerWatch: HTMLElement | null = null;
let containerObserver: ResizeObserver | null = null;

/**
 * Tell the probe which element governs the sidebar's content width. Once
 * set, the probe will re-measure heights whenever that element resizes
 * (e.g. user collapses the sidebar). Safe to call multiple times - we only
 * keep the latest container.
 */
export function bindRowHeightProbeContainer(el: HTMLElement) {
  if (containerWatch === el) return;
  if (containerObserver) {
    containerObserver.disconnect();
    containerObserver = null;
  }
  containerWatch = el;
  // Force re-measure now that we have a real container.
  cached = null;
  containerObserver = new ResizeObserver(() => {
    invalidateProbe();
  });
  containerObserver.observe(el);
}

/** Subscribe to invalidations. Returns an unsubscribe function. */
export function subscribeRowHeightProbe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Discard the cache; next call to the probe accessors will re-measure. */
export function invalidateProbe() {
  cached = null;
  for (const fn of listeners) fn();
}

function ensureProbed(): ProbedHeights {
  if (cached) return cached;
  cached = runProbe();
  return cached;
}

function runProbe(): ProbedHeights {
  const widthPx = (() => {
    if (containerWatch) {
      // Use the inner content box of the bound container so padding is
      // already excluded - matches the actual width a row gets to render
      // its text in.
      return containerWatch.clientWidth;
    }
    // Fallback: sensible default matching the sidebar's design width minus
    // the typical row padding. Used only before bindRowHeightProbeContainer
    // is called.
    return 248 - 4; // 2px lateral padding on each side of the list
  })();

  // Build a hidden host that mirrors the sidebar's row environment. We use
  // the same classes the live list uses so the cascade gives us exact
  // computed styles.
  const host = document.createElement("div");
  host.style.position = "absolute";
  host.style.visibility = "hidden";
  host.style.pointerEvents = "none";
  host.style.left = "-99999px";
  host.style.top = "0";
  host.style.width = `${widthPx}px`;
  host.className = "nz-mvlist nz-others-mvlist";

  const ul = document.createElement("ul");
  ul.className = "nz-note-list";
  host.appendChild(ul);
  document.body.appendChild(host);

  // We need a long enough preview string to force 2 wrapped lines in the
  // 2-line probe. 240 chars of "Lorem ipsum…"-ish filler comfortably
  // overflows two lines at any practical sidebar width.
  const longPreview =
    "The quick brown fox jumps over the lazy dog. " +
    "The quick brown fox jumps over the lazy dog. " +
    "The quick brown fox jumps over the lazy dog. " +
    "The quick brown fox jumps over the lazy dog. " +
    "The quick brown fox jumps over the lazy dog.";

  const heights: Record<Kind, number> = { 0: 0, 1: 0, 2: 0 };
  let previewEl: HTMLElement | null = null;

  for (const kind of KIND_VALUES) {
    const li = document.createElement("li");
    li.className = "nz-note-item";
    if (kind === 1) li.classList.add("preview-1");
    if (kind === 2) li.classList.add("preview-2");

    const row = document.createElement("div");
    row.className = "nz-note-row";
    const title = document.createElement("span");
    title.className = "nz-note-title";
    title.textContent = "Probe Row";
    const time = document.createElement("span");
    time.className = "nz-note-time";
    time.textContent = "12m ago";
    row.appendChild(title);
    row.appendChild(time);
    li.appendChild(row);

    if (kind > 0) {
      const meta = document.createElement("div");
      meta.className = "nz-note-meta";
      const preview = document.createElement("span");
      preview.className = "nz-note-preview";
      preview.textContent = longPreview;
      meta.appendChild(preview);
      li.appendChild(meta);
      if (kind === 1 && !previewEl) previewEl = preview;
    }

    ul.appendChild(li);
    heights[kind] = li.getBoundingClientRect().height;
  }

  // Read the live preview font for canvas measurement BEFORE removing the
  // host. Using getComputedStyle on the actual DOM node guarantees we
  // capture inherited font-family and any ancestor overrides.
  let previewFont = "11.5px system-ui, -apple-system, sans-serif";
  let previewContentWidth = widthPx;
  if (previewEl) {
    const cs = getComputedStyle(previewEl);
    previewFont =
      `${cs.fontStyle} ${cs.fontVariant} ${cs.fontWeight} ${cs.fontSize} / ${cs.lineHeight} ${cs.fontFamily}`.trim();
    // Actual content width inside the preview span (its parent has padding
    // from .nz-note-item; we want the width text gets to flow into).
    const meta = previewEl.parentElement!;
    previewContentWidth = meta.clientWidth || widthPx;
  }

  document.body.removeChild(host);

  return {
    byKind: heights,
    previewContentWidth,
    previewFont,
  };
}

function getCanvas(): CanvasRenderingContext2D {
  if (!canvas) {
    canvas = document.createElement("canvas");
    ctx = canvas.getContext("2d");
  }
  return ctx!;
}

/** Width in CSS px the preview string would render as on a single
 *  unwrapped line. ~1µs, no DOM, no layout. */
function measureTextWidthPx(text: string, font: string): number {
  const c = getCanvas();
  if (c.font !== font) c.font = font;
  return c.measureText(text).width;
}

/** How many wrapped lines `preview` will need, capped at `maxLines`.
 *  Uses canvas text measurement against the probed available width. */
export function previewLineCount(preview: string, maxLines: number): number {
  if (maxLines <= 0) return 0;
  const trimmed = preview.trim();
  if (!trimmed) return 0;
  const probed = ensureProbed();
  const width = measureTextWidthPx(trimmed, probed.previewFont);
  if (probed.previewContentWidth <= 0) return Math.min(1, maxLines);
  const lines = Math.ceil(width / probed.previewContentWidth);
  return Math.min(Math.max(lines, 1), maxLines);
}

/** Exact pixel height for a row containing `lines` preview lines. */
export function rowHeightForLines(lines: 0 | 1 | 2): number {
  const probed = ensureProbed();
  return probed.byKind[lines];
}

/** Convenience: combined lookup from (preview text, max-lines setting) to
 *  the exact row height. Used by the sidebar's virtualizer estimator. */
export function rowHeightForPreview(preview: string, maxLines: number): number {
  const lines = previewLineCount(preview, maxLines) as 0 | 1 | 2;
  return rowHeightForLines(lines);
}
