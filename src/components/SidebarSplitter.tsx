import { type Component, onCleanup } from "solid-js";
import { setSidebarWidth, sidebarCollapsed, sidebarWidth } from "../stores/ui";

/**
 * Drag handle between the sidebar and the main column. Mirrors the pane
 * splitter pattern - 6px-wide invisible track that turns into the accent line
 * on hover/drag. Direction is fixed (column resize), so the math is simpler:
 * the new width is just the cursor's clientX relative to the window edge.
 *
 * Hidden when the sidebar is collapsed - resizing a 0-width column doesn't
 * make sense and the handle would float over empty space.
 */
export const SidebarSplitter: Component = () => {
  let handleEl: HTMLDivElement | undefined;
  let listeners: { move: (e: PointerEvent) => void; up: () => void } | null = null;

  const cleanup = () => {
    if (!listeners) return;
    document.removeEventListener("pointermove", listeners.move);
    document.removeEventListener("pointerup", listeners.up);
    document.removeEventListener("pointercancel", listeners.up);
    listeners = null;
    document.body.classList.remove("nz-resizing");
  };

  const handlePointerDown = (e: PointerEvent) => {
    if (e.button !== 0 || !handleEl || sidebarCollapsed()) return;
    e.preventDefault();
    e.stopPropagation();

    document.body.classList.add("nz-resizing");
    handleEl.setPointerCapture(e.pointerId);

    // The sidebar starts at the window's left edge (after the .nz-app's
    // padding-left of 6px). The new width is cursor clientX minus that pad,
    // so the splitter visually tracks the user's pointer.
    const startWidth = sidebarWidth();
    const startX = e.clientX;

    const move = (ev: PointerEvent) => {
      const delta = ev.clientX - startX;
      setSidebarWidth(startWidth + delta);
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
      class="nz-sidebar-splitter"
      onPointerDown={handlePointerDown}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
    />
  );
};
