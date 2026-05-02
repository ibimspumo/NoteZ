import { mergeRegister } from "@lexical/utils";
import {
  $createNodeSelection,
  $getNearestNodeFromDOMNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isNodeSelection,
  $isRangeSelection,
  $isRootNode,
  $setSelection,
  COMMAND_PRIORITY_LOW,
  DRAGOVER_COMMAND,
  DROP_COMMAND,
  type LexicalEditor,
  type LexicalNode,
  PASTE_COMMAND,
} from "lexical";
import { api } from "../../../lib/tauri";
import { $createImageNode, $isImageNode, applyWidthStyle } from "./imageNode";

const ACCEPTED_IMAGE_MIMES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/webp",
]);

/**
 * Custom MIME used to mark an internal image-reorder drag. The browser's drag
 * machinery owns `dataTransfer.types`, so a private MIME lets us cheaply
 * disambiguate "moving an existing node" from "dropping an external file"
 * without inspecting global state.
 */
const NOTEZ_IMAGE_MIME = "application/x-notez-image-key";

const MIN_IMAGE_WIDTH_PX = 80;
const RESIZE_PCT_PRECISION = 10; // round to 0.1 %

type DropTarget = { blockKey: string; position: "before" | "after" } | null;

type ResizeState = {
  nodeKey: string;
  figure: HTMLElement;
  /** "w" corners drag the left edge, "e" corners drag the right edge. */
  corner: "nw" | "ne" | "sw" | "se";
  startX: number;
  startWidthPx: number;
  parentWidthPx: number;
  /** Last pct applied to the live DOM - committed to the node on pointerup. */
  lastPct: number | null;
};

/**
 * Wires up everything that makes images "tangible":
 *   - paste / external-file drop → import asset, insert ImageNode
 *   - click on figure            → select via NodeSelection (CSS ring + handles)
 *   - corner-handle drag         → resize (live DOM, commit to node on release)
 *   - figure drag                → reorder between blocks via HTML5 DnD
 *   - drop indicator             → 2 px line previewing the insertion point
 *
 * `root` is the contenteditable element (`.nz-editor-content`); the indicator
 * lives in its parent (`.nz-editor-shell`), which is `position: relative`.
 */
export function registerImagePlugin(editor: LexicalEditor, root: HTMLElement): () => void {
  const shell = root.parentElement;
  const indicator = document.createElement("div");
  indicator.className = "nz-drop-indicator";
  indicator.setAttribute("aria-hidden", "true");
  indicator.style.display = "none";
  if (shell) shell.appendChild(indicator);

  const hideIndicator = () => {
    indicator.style.display = "none";
  };

  // ─── drop-target geometry ─────────────────────────────────────────────
  // Walk the editor's top-level blocks and find the one whose vertical span
  // contains `clientY` (or the closest one above/below). Cursor above the
  // block midpoint → insert before; below → insert after.
  const computeDropTarget = (clientY: number): DropTarget => {
    const blocks: HTMLElement[] = [];
    for (const child of Array.from(root.children)) {
      if (child instanceof HTMLElement) blocks.push(child);
    }
    if (blocks.length === 0) return null;

    let targetEl: HTMLElement | null = null;
    let position: "before" | "after" = "after";

    for (const block of blocks) {
      const rect = block.getBoundingClientRect();
      if (clientY < rect.top) {
        targetEl = block;
        position = "before";
        break;
      }
      if (clientY <= rect.bottom) {
        const mid = rect.top + rect.height / 2;
        targetEl = block;
        position = clientY < mid ? "before" : "after";
        break;
      }
    }
    if (!targetEl) {
      targetEl = blocks[blocks.length - 1];
      position = "after";
    }

    let blockKey: string | null = null;
    editor.getEditorState().read(() => {
      const node = $getNearestNodeFromDOMNode(targetEl!);
      if (!node) return;
      // Walk up to a direct child of the root node - that's the "block" level
      // where reordering makes sense.
      let cur: LexicalNode | null = node;
      while (cur) {
        const parent: LexicalNode | null = cur.getParent();
        if (!parent || $isRootNode(parent)) break;
        cur = parent;
      }
      if (cur) blockKey = cur.getKey();
    });

    if (!blockKey) return null;
    return { blockKey, position };
  };

  const showIndicator = (target: DropTarget) => {
    if (!target || !shell) {
      hideIndicator();
      return;
    }
    const blockEl = editor.getElementByKey(target.blockKey);
    if (!blockEl) {
      hideIndicator();
      return;
    }
    const blockRect = blockEl.getBoundingClientRect();
    const shellRect = shell.getBoundingClientRect();
    const top =
      target.position === "before"
        ? blockRect.top - shellRect.top
        : blockRect.bottom - shellRect.top;
    indicator.style.display = "block";
    indicator.style.top = `${top - 1}px`;
    indicator.style.left = `${blockRect.left - shellRect.left}px`;
    indicator.style.width = `${blockRect.width}px`;
  };

  // ─── selection sync ───────────────────────────────────────────────────
  // Toggle `.selected` on the figure that backs the currently-selected
  // ImageNode. We track the previous key so we only mutate two DOM elements
  // per update instead of querying every figure.
  let selectedKey: string | null = null;
  const cleanupSelectionSync = editor.registerUpdateListener(() => {
    let nextKey: string | null = null;
    editor.getEditorState().read(() => {
      const sel = $getSelection();
      if ($isNodeSelection(sel)) {
        for (const node of sel.getNodes()) {
          if ($isImageNode(node)) {
            nextKey = node.getKey();
            break;
          }
        }
      }
    });
    if (nextKey === selectedKey) return;
    if (selectedKey) {
      const el = editor.getElementByKey(selectedKey);
      if (el) el.classList.remove("selected");
    }
    if (nextKey) {
      const el = editor.getElementByKey(nextKey);
      if (el) el.classList.add("selected");
    }
    selectedKey = nextKey;
  });

  // ─── click → select image ─────────────────────────────────────────────
  const onClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    if (target.classList.contains("nz-image-handle")) return; // resize, not select
    const figure = target.closest<HTMLElement>(".nz-image");
    if (!figure || !root.contains(figure)) return;
    e.preventDefault();
    editor.update(() => {
      const node = $getNearestNodeFromDOMNode(figure);
      if (node && $isImageNode(node)) {
        const sel = $createNodeSelection();
        sel.add(node.getKey());
        $setSelection(sel);
      }
    });
  };
  root.addEventListener("click", onClick);

  // ─── resize via pointer events ────────────────────────────────────────
  // We update the figure's inline width on every pointermove for instant
  // feedback, then commit the final pct to the node once on pointerup so
  // the editor history sees a single resize step rather than a flood.
  let resize: ResizeState | null = null;

  const onPointerDown = (e: PointerEvent) => {
    const target = e.target as HTMLElement | null;
    if (!target || !target.classList.contains("nz-image-handle")) return;
    const figure = target.closest<HTMLElement>(".nz-image");
    if (!figure) return;
    const corner = target.getAttribute("data-corner") as ResizeState["corner"] | null;
    if (!corner) return;
    const parent = figure.parentElement;
    if (!parent) return;

    let nodeKey: string | null = null;
    editor.getEditorState().read(() => {
      const node = $getNearestNodeFromDOMNode(figure);
      if (node && $isImageNode(node)) nodeKey = node.getKey();
    });
    if (!nodeKey) return;

    e.preventDefault();
    e.stopPropagation();

    const figureRect = figure.getBoundingClientRect();
    const parentRect = parent.getBoundingClientRect();

    resize = {
      nodeKey,
      figure,
      corner,
      startX: e.clientX,
      startWidthPx: figureRect.width,
      parentWidthPx: parentRect.width,
      lastPct: null,
    };

    figure.classList.add("resizing");
    try {
      target.setPointerCapture(e.pointerId);
    } catch {
      // setPointerCapture can throw if the pointer is already gone; harmless.
    }
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!resize) return;
    const dx = e.clientX - resize.startX;
    // East handles grow with +dx; west handles grow with -dx.
    const delta = resize.corner.endsWith("e") ? dx : -dx;
    const rawWidth = resize.startWidthPx + delta;
    const clamped = Math.max(MIN_IMAGE_WIDTH_PX, Math.min(resize.parentWidthPx, rawWidth));
    const pct =
      Math.round((clamped / resize.parentWidthPx) * 100 * RESIZE_PCT_PRECISION) /
      RESIZE_PCT_PRECISION;
    applyWidthStyle(resize.figure, pct);
    resize.lastPct = pct;
  };

  const onPointerUp = () => {
    if (!resize) return;
    const finalPct = resize.lastPct;
    const key = resize.nodeKey;
    const figure = resize.figure;
    figure.classList.remove("resizing");
    resize = null;
    if (finalPct == null) return;
    editor.update(() => {
      const node = $getNodeByKey(key);
      if ($isImageNode(node)) node.setWidthPct(finalPct);
    });
  };

  root.addEventListener("pointerdown", onPointerDown);
  // Listen on window for move/up so a fast drag that leaves the editor
  // doesn't strand us in a half-resized state.
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerUp);

  // ─── drag-reorder ─────────────────────────────────────────────────────
  const onDragStart = (e: DragEvent) => {
    // Resize is in progress (user pressed a handle) - don't let the browser
    // also start a node-move drag. The dragstart event fires on the figure
    // regardless of which descendant the mousedown originated on, so checking
    // resize state is more reliable than inspecting `e.target`.
    if (resize) {
      e.preventDefault();
      return;
    }
    const target = e.target as HTMLElement | null;
    if (!target || !e.dataTransfer) return;
    const figure = target.closest<HTMLElement>(".nz-image");
    if (!figure || !root.contains(figure)) return;

    let key: string | null = null;
    editor.getEditorState().read(() => {
      const node = $getNearestNodeFromDOMNode(figure);
      if (node && $isImageNode(node)) key = node.getKey();
    });
    if (!key) return;

    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData(NOTEZ_IMAGE_MIME, key);
    // The browser snapshots the drag image at this moment - using the figure
    // itself gives a faithful preview that follows the cursor.
    e.dataTransfer.setDragImage(figure, 16, 16);
    figure.classList.add("dragging");
  };

  const onDragEnd = (e: DragEvent) => {
    const target = e.target as HTMLElement | null;
    const figure = target?.closest<HTMLElement>(".nz-image");
    if (figure) figure.classList.remove("dragging");
    hideIndicator();
  };

  root.addEventListener("dragstart", onDragStart);
  root.addEventListener("dragend", onDragEnd);

  // ─── lexical commands: dragover/drop/paste ────────────────────────────
  // We register at LOW priority so `registerRichText` can still claim
  // text-style drops first; image events return `true` to consume.
  const cleanupCommands = mergeRegister(
    editor.registerCommand(
      PASTE_COMMAND,
      (event: ClipboardEvent) => {
        const files = collectImageFiles(event.clipboardData);
        if (files.length === 0) return false;
        event.preventDefault();
        void importImageFiles(editor, files, null);
        return true;
      },
      COMMAND_PRIORITY_LOW,
    ),
    editor.registerCommand(
      DRAGOVER_COMMAND,
      (event: DragEvent) => {
        const dt = event.dataTransfer;
        if (!dt) return false;
        const isInternal = dt.types.includes(NOTEZ_IMAGE_MIME);
        const isFile = isFileDrag(dt);
        if (!isInternal && !isFile) return false;
        event.preventDefault();
        dt.dropEffect = isInternal ? "move" : "copy";
        showIndicator(computeDropTarget(event.clientY));
        return true;
      },
      COMMAND_PRIORITY_LOW,
    ),
    editor.registerCommand(
      DROP_COMMAND,
      (event: DragEvent) => {
        const dt = event.dataTransfer;
        if (!dt) return false;

        // Internal reorder.
        if (dt.types.includes(NOTEZ_IMAGE_MIME)) {
          event.preventDefault();
          const movedKey = dt.getData(NOTEZ_IMAGE_MIME);
          const target = computeDropTarget(event.clientY);
          hideIndicator();
          if (!movedKey || !target) return true;
          editor.update(() => {
            const moved = $getNodeByKey(movedKey);
            const anchor = $getNodeByKey(target.blockKey);
            if (!moved || !anchor) return;
            if (moved === anchor) return;
            // Reorder is idempotent if dropped right next to itself; let
            // Lexical re-parent regardless - cheap and correct.
            if (target.position === "before") anchor.insertBefore(moved);
            else anchor.insertAfter(moved);
            // Re-select the moved node so the user can keep manipulating it
            // without an extra click.
            const sel = $createNodeSelection();
            sel.add(moved.getKey());
            $setSelection(sel);
          });
          return true;
        }

        // External file drop.
        const files = collectImageFiles(dt);
        if (files.length === 0) return false;
        event.preventDefault();
        const target = computeDropTarget(event.clientY);
        hideIndicator();
        void importImageFiles(editor, files, target);
        return true;
      },
      COMMAND_PRIORITY_LOW,
    ),
  );

  // The browser fires `dragleave` whenever the cursor crosses a child
  // boundary, so naive hide-on-leave flickers. We only hide when leaving
  // the editor entirely.
  const onDragLeave = (e: DragEvent) => {
    const related = e.relatedTarget as Node | null;
    if (!related || !root.contains(related)) hideIndicator();
  };
  root.addEventListener("dragleave", onDragLeave);

  return () => {
    root.removeEventListener("click", onClick);
    root.removeEventListener("pointerdown", onPointerDown);
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerUp);
    root.removeEventListener("dragstart", onDragStart);
    root.removeEventListener("dragend", onDragEnd);
    root.removeEventListener("dragleave", onDragLeave);
    cleanupSelectionSync();
    cleanupCommands();
    indicator.remove();
  };
}

function isFileDrag(dt: DataTransfer): boolean {
  for (const t of dt.types) if (t === "Files") return true;
  return false;
}

function collectImageFiles(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  const out: File[] = [];
  for (const f of dt.files) {
    if (ACCEPTED_IMAGE_MIMES.has(f.type)) out.push(f);
  }
  return out;
}

function extFromMime(mime: string): string {
  switch (mime.toLowerCase()) {
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    default:
      return "bin";
  }
}

async function importImageFiles(editor: LexicalEditor, files: File[], target: DropTarget) {
  // When dropping multiple files at one location, each successive one is
  // inserted *after* the previous one so the on-screen order matches the
  // file array. We thread `cursor` through to track this.
  let cursor = target;
  for (const file of files) {
    try {
      const buf = await file.arrayBuffer();
      // Tauri 2 accepts a typed array directly; avoiding `Array.from(...)`
      // saves a full O(n) copy through `number[]`. For a 5 MB image that's
      // ~50 ms saved on M1 (~150 ms before, ~100 ms after) - mostly the
      // structured-clone serialization itself. For drag-from-Finder we use
      // `save_asset_from_path` instead, which avoids the bytes hop entirely.
      const bytes = new Uint8Array(buf);
      const ref = await api.saveAsset(bytes as unknown as number[], file.type);
      editor.update(() => {
        const node = $createImageNode({
          assetId: ref.id,
          ext: extFromMime(ref.mime),
          width: ref.width,
          height: ref.height,
          blurhash: ref.blurhash,
          alt: file.name,
        });
        if (cursor) {
          const anchor = $getNodeByKey(cursor.blockKey);
          if (anchor) {
            if (cursor.position === "before") anchor.insertBefore(node);
            else anchor.insertAfter(node);
            cursor = { blockKey: node.getKey(), position: "after" };
            return;
          }
        }
        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          selection.insertNodes([node]);
        } else {
          $getRoot().append(node);
        }
        cursor = { blockKey: node.getKey(), position: "after" };
      });
    } catch (e) {
      console.error("import image failed:", e);
    }
  }
}
