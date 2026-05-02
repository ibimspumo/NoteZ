import { type Component, onCleanup } from "solid-js";
import { type SplitId, setBoundary } from "../../stores/panes";

type Props = {
  splitId: SplitId;
  /** Index of the LEFT/TOP child relative to its split's children array. */
  boundaryIdx: number;
  direction: "row" | "column";
};

/**
 * Drag handle between two adjacent split children. Reads the current viewport
 * positions of the LEFT and RIGHT cells from `previousElementSibling` /
 * `nextElementSibling` at pointerdown - cheaper than threading bounding-rects
 * through Solid signals on every move, and accurate even when nested splits
 * recompute their own sub-fractions.
 */
export const PaneSplitter: Component<Props> = (props) => {
  let handleEl: HTMLDivElement | undefined;
  let listeners: { move: (e: PointerEvent) => void; up: (e: PointerEvent) => void } | null = null;

  const cleanup = () => {
    if (!listeners) return;
    document.removeEventListener("pointermove", listeners.move);
    document.removeEventListener("pointerup", listeners.up);
    document.removeEventListener("pointercancel", listeners.up);
    listeners = null;
    document.body.classList.remove("nz-resizing");
  };

  const handlePointerDown = (e: PointerEvent) => {
    if (e.button !== 0 || !handleEl) return;
    e.preventDefault();
    e.stopPropagation();

    const leftEl = handleEl.previousElementSibling as HTMLElement | null;
    const rightEl = handleEl.nextElementSibling as HTMLElement | null;
    if (!leftEl || !rightEl) return;

    const isRow = props.direction === "row";
    const leftRect = leftEl.getBoundingClientRect();
    const rightRect = rightEl.getBoundingClientRect();
    const startPos = isRow ? leftRect.left : leftRect.top;
    const endPos = isRow ? rightRect.right : rightRect.bottom;
    const span = endPos - startPos;
    if (span <= 0) return;

    document.body.classList.add("nz-resizing");
    handleEl.setPointerCapture(e.pointerId);

    const move = (ev: PointerEvent) => {
      const cursor = isRow ? ev.clientX : ev.clientY;
      const fraction = (cursor - startPos) / span;
      setBoundary(props.splitId, props.boundaryIdx, fraction);
    };
    const up = () => cleanup();

    listeners = { move, up };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
    document.addEventListener("pointercancel", up);
  };

  onCleanup(cleanup);

  return (
    <div
      ref={(el) => (handleEl = el)}
      class="nz-pane-splitter"
      classList={{ row: props.direction === "row", column: props.direction === "column" }}
      onPointerDown={handlePointerDown}
      role="separator"
      aria-orientation={props.direction === "row" ? "vertical" : "horizontal"}
    />
  );
};
