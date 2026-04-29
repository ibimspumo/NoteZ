import { decode as decodeBlurhash } from "blurhash";
import {
  $applyNodeReplacement,
  type EditorConfig,
  ElementNode,
  type LexicalNode,
  type NodeKey,
  type SerializedElementNode,
  type Spread,
} from "lexical";
import { BLURHASH_CACHE_MAX } from "../../../lib/constants";
import { LRU } from "../../../lib/lru";
import { api, assetUrl } from "../../../lib/tauri";

export type SerializedImageNode = Spread<
  {
    /** Content-addressed sha256 of the bytes - the only stable handle. */
    assetId: string;
    /** File extension (without dot) - needed to reconstruct the on-disk path. */
    ext: string;
    width: number;
    height: number;
    /** Blurhash for low-quality preview before the real bitmap loads. */
    blurhash: string | null;
    /** Optional alt text for accessibility. */
    alt: string;
    /**
     * User-resized display width as a percentage of the editor column.
     * `null` means "natural" - fall back to the CSS default (100% capped at 720px).
     * Old notes (pre-resize) deserialize with `null` and stay visually identical.
     */
    widthPct: number | null;
  },
  SerializedElementNode
>;

/**
 * Block-level image embed.
 *
 * Render pipeline:
 *   1. `createDOM` builds a `<figure>` with a wrapper sized to the image's
 *      aspect ratio so layout is stable from the first paint.
 *   2. The wrapper gets a blurhash background painted to a small data-URI canvas.
 *      This makes the image look "filled in" before the real bitmap loads -
 *      no layout shift, no flash of empty space.
 *   3. An `<img>` is inserted on top with `loading="lazy"` and `decoding="async"`.
 *      It fades in over the blurhash once decoded.
 *
 * Storage:
 *   - The on-disk path is *not* serialized. We persist `assetId` + `ext` and
 *     reconstruct the path at render time from a cached `assetsDir` (set once
 *     at app startup). This survives data-dir moves between Macs.
 *   - If `assetsDir` is not yet known when a node is created (very early render
 *     before init finishes), we fall back to an async `api.getAsset(id)` lookup.
 *
 * This node is "atomic" (a token): the cursor jumps over it as a unit, the
 * full embed is preserved in copy/paste, and Lexical's history undoes it as one.
 */
export class ImageNode extends ElementNode {
  __assetId: string;
  __ext: string;
  __width: number;
  __height: number;
  __blurhash: string | null;
  __alt: string;
  __widthPct: number | null;

  static getType(): string {
    return "image";
  }

  static clone(n: ImageNode): ImageNode {
    return new ImageNode(
      n.__assetId,
      n.__ext,
      n.__width,
      n.__height,
      n.__blurhash,
      n.__alt,
      n.__widthPct,
      n.__key,
    );
  }

  constructor(
    assetId: string,
    ext: string,
    width: number,
    height: number,
    blurhash: string | null,
    alt: string,
    widthPct: number | null,
    key?: NodeKey,
  ) {
    super(key);
    this.__assetId = assetId;
    this.__ext = ext;
    this.__width = width;
    this.__height = height;
    this.__blurhash = blurhash;
    this.__alt = alt;
    this.__widthPct = widthPct;
  }

  getAssetId(): string {
    return this.__assetId;
  }

  getWidthPct(): number | null {
    return this.__widthPct;
  }

  setWidthPct(pct: number | null): this {
    const writable = this.getWritable();
    writable.__widthPct = pct;
    return writable;
  }

  createDOM(_config: EditorConfig): HTMLElement {
    const figure = document.createElement("figure");
    figure.className = "nz-image";
    figure.setAttribute("data-lexical-image", "true");
    figure.setAttribute("data-asset-id", this.__assetId);
    figure.setAttribute("contenteditable", "false");
    figure.draggable = true;
    applyWidthStyle(figure, this.__widthPct);

    const wrap = document.createElement("div");
    wrap.className = "nz-image-wrap";
    if (this.__width > 0 && this.__height > 0) {
      wrap.style.aspectRatio = `${this.__width} / ${this.__height}`;
    }

    if (this.__blurhash) {
      const dataUrl = blurhashToDataUrl(this.__blurhash, 32, 24);
      if (dataUrl) wrap.style.backgroundImage = `url(${dataUrl})`;
    }

    const img = document.createElement("img");
    img.alt = this.__alt;
    img.loading = "lazy";
    img.decoding = "async";
    img.draggable = false;
    img.className = "nz-image-img";
    img.addEventListener("load", () => img.classList.add("loaded"), { once: true });

    // Sync path resolution from the cached assets dir; falls back to an async
    // IPC lookup if the cache wasn't initialized yet.
    const syncPath = resolveAssetPathSync(this.__assetId, this.__ext);
    if (syncPath) {
      img.src = assetUrl(syncPath);
    } else {
      const id = this.__assetId;
      void api.getAsset(id).then((ref) => {
        if (ref) img.src = assetUrl(ref.path);
      });
    }

    wrap.appendChild(img);
    figure.appendChild(wrap);

    // Resize handles. Always present in the DOM so they survive Lexical
    // reconciliation, but only visible when the figure has the `.selected`
    // class (driven by NodeSelection - see imagePlugin.ts).
    for (const corner of ["nw", "ne", "sw", "se"] as const) {
      const handle = document.createElement("div");
      handle.className = `nz-image-handle nz-image-handle-${corner}`;
      handle.setAttribute("data-corner", corner);
      handle.setAttribute("contenteditable", "false");
      figure.appendChild(handle);
    }

    return figure;
  }

  updateDOM(prev: ImageNode, dom: HTMLElement, _config: EditorConfig): boolean {
    // Path is content-addressed (sha256) - if the assetId hasn't changed, the
    // bytes haven't changed, and we can reuse the existing DOM. If the assetId
    // changes, returning true tells Lexical to recreate the DOM.
    if (prev.__assetId !== this.__assetId) return true;
    if (prev.__widthPct !== this.__widthPct) {
      applyWidthStyle(dom, this.__widthPct);
    }
    return false;
  }

  isInline(): boolean {
    return false;
  }

  isToken(): boolean {
    return true;
  }

  canBeEmpty(): boolean {
    return true;
  }

  exportJSON(): SerializedImageNode {
    return {
      ...super.exportJSON(),
      type: "image",
      version: 1,
      assetId: this.__assetId,
      ext: this.__ext,
      width: this.__width,
      height: this.__height,
      blurhash: this.__blurhash,
      alt: this.__alt,
      widthPct: this.__widthPct,
    };
  }

  static importJSON(s: SerializedImageNode): ImageNode {
    return $createImageNode({
      assetId: s.assetId,
      ext: s.ext,
      width: s.width,
      height: s.height,
      blurhash: s.blurhash,
      alt: s.alt ?? "",
      widthPct: s.widthPct ?? null,
    });
  }

  getTextContent(): string {
    return this.__alt ? `[image: ${this.__alt}]` : "[image]";
  }
}

export type CreateImageInput = {
  assetId: string;
  ext: string;
  width: number;
  height: number;
  blurhash: string | null;
  alt?: string;
  widthPct?: number | null;
};

export function $createImageNode(input: CreateImageInput): ImageNode {
  return $applyNodeReplacement(
    new ImageNode(
      input.assetId,
      input.ext,
      input.width,
      input.height,
      input.blurhash,
      input.alt ?? "",
      input.widthPct ?? null,
    ),
  );
}

/**
 * Apply the user-resized width to a figure DOM node. Kept as a free function
 * so `imagePlugin.ts` can use the same logic for the live-drag preview without
 * round-tripping through Lexical state on every pointer move.
 */
export function applyWidthStyle(figure: HTMLElement, widthPct: number | null) {
  if (widthPct == null) {
    figure.style.width = "";
    figure.style.maxWidth = "";
  } else {
    figure.style.width = `${widthPct}%`;
    figure.style.maxWidth = "none";
  }
}

export function $isImageNode(n: LexicalNode | null | undefined): n is ImageNode {
  return n instanceof ImageNode;
}

// `collectAssetIds` is now backed by `editorRefs` mutation tracking - O(refs)
// instead of O(nodes) and free of the `_nodeMap` private API. Re-exported here
// so existing call sites don't have to change their import path.
export { collectAssetIds } from "./editorRefs";

// --- assets dir cache ---

let cachedAssetsDir: string | null = null;
let assetsDirLoad: Promise<string> | null = null;

/**
 * Initialize the cached assets directory. Call once at app startup (in App.tsx).
 * Subsequent calls are deduped, so it's safe to call from multiple call sites.
 *
 * On failure we deliberately reset `assetsDirLoad` back to `null` so the next
 * call gets a fresh chance. Without this, a single transient IPC error at
 * boot (e.g. the backend hadn't finished `setup()` yet) would stick the
 * promise in a rejected state forever, and every image render afterward would
 * fall through to the slow per-image `getAsset` IPC.
 */
export function initAssetsDir(): Promise<string> {
  if (cachedAssetsDir) return Promise.resolve(cachedAssetsDir);
  if (assetsDirLoad) return assetsDirLoad;
  assetsDirLoad = api
    .getAssetsDir()
    .then((dir) => {
      cachedAssetsDir = dir;
      return dir;
    })
    .catch((err) => {
      assetsDirLoad = null;
      throw err;
    });
  return assetsDirLoad;
}

function resolveAssetPathSync(id: string, ext: string): string | null {
  if (!cachedAssetsDir) return null;
  // Mirrors the Rust-side layout: <assets_dir>/<id[0:2]>/<id>.<ext>
  const sep = cachedAssetsDir.includes("\\") && !cachedAssetsDir.includes("/") ? "\\" : "/";
  return `${cachedAssetsDir}${sep}${id.slice(0, 2)}${sep}${id}.${ext}`;
}

// --- blurhash → data URL ---

const blurhashCache = new LRU<string, string>(BLURHASH_CACHE_MAX);

function blurhashToDataUrl(hash: string, w: number, h: number): string | null {
  const cacheKey = `${hash}|${w}x${h}`;
  const cached = blurhashCache.get(cacheKey);
  if (cached !== undefined) return cached;
  try {
    const pixels = decodeBlurhash(hash, w, h);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const imgData = ctx.createImageData(w, h);
    imgData.data.set(pixels);
    ctx.putImageData(imgData, 0, 0);
    const url = canvas.toDataURL("image/png");
    blurhashCache.set(cacheKey, url);
    return url;
  } catch {
    return null;
  }
}
