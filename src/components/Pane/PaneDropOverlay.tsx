import { Show, type Component, createSignal, onCleanup, onMount } from "solid-js";
import { type PaneId, dragNoteId, endNoteDrag, openNoteInPane, splitPane } from "../../stores/panes";

type Zone = "center" | "left" | "right" | "top" | "bottom" | null;

type Props = {
  paneId: PaneId;
};

/**
 * Five-zone drop target shown over a pane during an active drag. Center
 * replaces the pane's note; the four edges split the pane in that direction.
 *
 * We compute the active zone purely from the cursor's relative position in
 * the overlay rect - cheap, no Solid reactivity in the hot path. The overlay
 * is mounted only when `dragNoteId()` is set, so the DOM cost is zero
 * outside of an active drag.
 */
export const PaneDropOverlay: Component<Props> = (props) => {
  const [zone, setZone] = createSignal<Zone>(null);
  let overlayRef: HTMLDivElement | undefined;

  onMount(() => {
    console.log(`[dnd] PaneDropOverlay mounted for pane ${props.paneId}`);
  });
  onCleanup(() => {
    console.log(`[dnd] PaneDropOverlay unmounted for pane ${props.paneId}`);
  });

  const computeZone = (e: DragEvent): Zone => {
    if (!overlayRef) return null;
    const rect = overlayRef.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    // Center zone: 40% × 40% box in the middle. Anything outside picks the
    // nearest edge by perpendicular distance, so corners resolve toward
    // whichever side the cursor is closer to.
    if (x > 0.3 && x < 0.7 && y > 0.3 && y < 0.7) return "center";
    const dl = x;
    const dr = 1 - x;
    const dt = y;
    const db = 1 - y;
    const min = Math.min(dl, dr, dt, db);
    if (min === dl) return "left";
    if (min === dr) return "right";
    if (min === dt) return "top";
    return "bottom";
  };

  const handleDragOver = (e: DragEvent) => {
    if (!dragNoteId()) {
      console.log(`[dnd] dragover on ${props.paneId} but no drag in progress`);
      return;
    }
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    const z = computeZone(e);
    if (z !== zone()) {
      console.log(`[dnd] zone change on ${props.paneId}:`, zone(), "->", z);
      setZone(z);
    }
  };

  const handleDragLeave = (e: DragEvent) => {
    const related = e.relatedTarget as Node | null;
    if (overlayRef && (!related || !overlayRef.contains(related))) {
      console.log(`[dnd] dragleave on ${props.paneId}, clearing zone`);
      setZone(null);
    }
  };

  const handleDrop = (e: DragEvent) => {
    console.log(`[dnd] DROP on ${props.paneId}, zone=${zone()}, dragNoteId=${dragNoteId()}`);
    e.preventDefault();
    const id = dragNoteId();
    const z = zone();
    setZone(null);
    endNoteDrag();
    if (!id) return;
    if (z === "center" || z === null) {
      openNoteInPane(props.paneId, id);
    } else {
      splitPane(props.paneId, z, id);
    }
  };

  return (
    <div
      ref={(el) => (overlayRef = el)}
      class="nz-pane-drop"
      onDragEnter={handleDragOver}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <Show when={zone()}>
        {(z) => (
          <div class="nz-pane-drop-highlight" data-zone={z()}>
            <div class="nz-pane-drop-label">{z() === "center" ? "Open in pane" : "Split"}</div>
          </div>
        )}
      </Show>
    </div>
  );
};
