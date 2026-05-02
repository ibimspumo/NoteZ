/**
 * Frontend constants. Single source of truth - mirror values that need to
 * agree with Rust live in `src-tauri/src/constants.rs` (manually kept in sync).
 *
 * No magic numbers in component code. If you find one, add it here.
 */

// ─── Save pipeline ─────────────────────────────────────────────────────────

/** Debounce window for the save-on-type pipeline. */
export const SAVE_DEBOUNCE_MS = 350;
/** Auto-snapshot cadence: at most one auto-snapshot per note per interval. */
export const SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;
/** How long the "Saved" indicator lingers after a successful save. */
export const SAVED_INDICATOR_MS = 800;
/** Editor cursor-position persistence debounce. */
export const PERSIST_DEBOUNCE_MS = 800;

// ─── Pagination & list windowing ───────────────────────────────────────────

/** Frontend page size for list_notes / list_trash. */
export const PAGE_SIZE = 100;
/** Once items exceeds this, we prune the oldest off the loaded prefix to
 *  cap memory. Backed up by the cursor so re-scrolling re-fetches. */
export const ITEMS_SLIDING_WINDOW_MAX = 5_000;
/** When pruning, keep this many items beyond what's currently in view. */
export const ITEMS_SLIDING_WINDOW_KEEP = 3_000;

// ─── Caches ────────────────────────────────────────────────────────────────

/** Note-detail cache cap. The cache is purely a latency-saver for the
 *  active editing session; capping it bounds memory at ~1 MB worst-case. */
export const NOTE_CACHE_MAX = 50;

/** Blurhash → data-URL cache cap. */
export const BLURHASH_CACHE_MAX = 200;

// ─── Workers ───────────────────────────────────────────────────────────────

/** Soft timeout for the off-thread JSON.stringify worker. */
export const STRINGIFY_TIMEOUT_MS = 10_000;

// ─── Search ────────────────────────────────────────────────────────────────

/** Command-bar search debounce. */
export const COMMAND_BAR_DEBOUNCE_MS = 60;
/** Default result count for the command bar. */
export const COMMAND_BAR_RESULTS = 12;
/** Empty-query top-N. */
export const COMMAND_BAR_RECENT = 8;

// ─── Toasts ────────────────────────────────────────────────────────────────

/** Default lifetime for an info / success toast. Errors stick until dismissed. */
export const TOAST_DEFAULT_MS = 4_000;

// ─── Image embeds ──────────────────────────────────────────────────────────

/** Resize precision (decimal places of percent). 10 → 0.1 % rounding. */
export const RESIZE_PCT_PRECISION = 10;
/** Hard floor on resized image width. */
export const MIN_IMAGE_WIDTH_PX = 80;

// ─── Defaults ──────────────────────────────────────────────────────────────

/** Default trash retention. 0 = never auto-delete. */
export const DEFAULT_TRASH_RETENTION_DAYS = 30;
/** Default sidebar preview lines. */
export const DEFAULT_SIDEBAR_PREVIEW_LINES = 2;
