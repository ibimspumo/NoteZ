import { batch, createMemo, createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { bucketBoundaries, bucketFor } from "../lib/buckets";
import {
  ITEMS_SLIDING_WINDOW_KEEP,
  ITEMS_SLIDING_WINDOW_MAX,
  NOTE_CACHE_MAX,
  PAGE_SIZE,
} from "../lib/constants";
import { LRU } from "../lib/lru";
import { api } from "../lib/tauri";
import type {
  FolderFilter,
  Note,
  NoteSummary,
  NotesCursor,
  TrashCursor,
  TrashSummary,
  UpdateNoteInput,
} from "../lib/types";
import {
  activeFolderFilter,
  bumpFolderNoteCount,
  noteFitsFilter,
  setActiveFolderFilter,
} from "./folders";
import { markAllTrashedAsMissing, setMentionStatus } from "./mentionRegistry";
import {
  activePaneNoteId,
  allTabApis,
  openNoteIds,
  openNoteInActivePane,
  openNoteInPane,
  paneForNote,
  reconcileLayoutWithNotes,
} from "./panes";

/**
 * Notes store. Two key invariants:
 *
 *   1. **Pinned notes are loaded in full, once.** Pinned counts are bounded by
 *      user behaviour (typically <50). They live in `pinned` and re-sort locally
 *      when toggled - we never refetch the whole list for a pin click.
 *
 *   2. **Unpinned notes are cursor-paginated.** `items` holds the loaded prefix;
 *      `nextCursor` points at the next page. The sidebar calls `loadMore()` when
 *      its sentinel scrolls into view. Initial page is 100 rows - at 5 KB of
 *      summary JSON each that's a 500 KB IPC, well under the 1 ms perceptual
 *      budget on a modern Mac.
 */
type NotesState = {
  pinned: NoteSummary[];
  items: NoteSummary[];
  nextCursor: NotesCursor | null;
  initialLoaded: boolean;
  loadingMore: boolean;
  trash: TrashSummary[];
  trashCursor: TrashCursor | null;
  trashLoaded: boolean;
};

const [state, setState] = createStore<NotesState>({
  pinned: [],
  items: [],
  nextCursor: null,
  initialLoaded: false,
  loadingMore: false,
  trash: [],
  trashCursor: null,
  trashLoaded: false,
});

// Per-note Lexical-state cache. Bounded LRU - the user is realistically
// editing one note at a time and bouncing through 5-10 in a session, so a
// 50-entry cap is generous. Without the cap the cache grows unbounded for
// users who navigate through their corpus over a long-running session.
const cache = new LRU<string, Note>(NOTE_CACHE_MAX);

export const notesState = state;

// Brief "just moved" flag used by the sidebar to play a small highlight
// animation on a row whose bucket or position changed during a save. Set
// from updateNote and auto-cleared after the animation duration. Single-id
// state - if a second note moves while the first is still highlighted, the
// flag jumps to the new id and the previous row's animation aborts.
//
// Generation token: rapid back-to-back `flashMoved` calls used to race - the
// first call's setTimeout would fire after the second's setRMI, clearing the
// (now-correct) signal mid-animation on the second note. We bump a counter
// per call and gate the timer's clear on its own generation, so only the
// most recent flash's timer clears the signal.
const [recentlyMovedId, setRecentlyMovedId] = createSignal<string | null>(null);
let flashGeneration = 0;
const MOVED_FLASH_MS = 600;

export const recentlyMovedNoteId = recentlyMovedId;

function flashMoved(id: string) {
  const my = ++flashGeneration;
  // Re-set in two ticks so the animation restarts cleanly when the same
  // note moves again before its previous flash finished.
  setRecentlyMovedId(null);
  queueMicrotask(() => {
    if (my !== flashGeneration) return;
    setRecentlyMovedId(id);
    window.setTimeout(() => {
      if (my !== flashGeneration) return;
      setRecentlyMovedId(null);
    }, MOVED_FLASH_MS);
  });
}

/** First-page load. Replaces both pinned + items. Reads the current
 *  folder filter from the folders store so the sidebar list scopes
 *  correctly when a folder is active. */
export async function refreshNotes() {
  const page = await api.listNotes(null, PAGE_SIZE, activeFolderFilter());
  setState(
    produce((s) => {
      s.pinned = page.pinned;
      s.items = page.items;
      s.nextCursor = page.next_cursor;
      s.initialLoaded = true;
    }),
  );
}

/** Switch the active folder filter and refresh the list from page 1.
 *  Resets the loaded prefix so the user sees the new scope immediately
 *  rather than the previous folder's notes scrolling away as more pages
 *  load. The active note selection isn't touched - the user can still see
 *  what they have open even if it isn't in the visible filter. */
export async function applyFolderFilter(filter: FolderFilter) {
  setActiveFolderFilter(filter);
  setState(
    produce((s) => {
      s.items = [];
      s.pinned = [];
      s.nextCursor = null;
      s.initialLoaded = false;
    }),
  );
  await refreshNotes();
}

/** Catastrophic reset. Clears the per-note cache, all loaded list state, and
 *  trash, then refetches the first page from scratch. Used after bulk
 *  server-side mutations (the dev panel's "delete all generated" flow) where
 *  patching local state row-by-row would be wrong-or-slow and any stale entry
 *  in `cache` would resurrect a deleted note when re-selected. */
export async function hardRefreshNotes() {
  cache.clear();
  setState({
    pinned: [],
    items: [],
    nextCursor: null,
    initialLoaded: false,
    loadingMore: false,
    trash: [],
    trashCursor: null,
    trashLoaded: false,
  });
  await Promise.all([refreshNotes(), pruneOrphanedTabsAgainstBackend()]);
}

/** Ask the backend which currently-open noteIds still exist, then null any
 *  tab whose note is gone. Without this, a bulk hard-delete (empty trash,
 *  purge old trash, dev "delete all generated") leaves orphaned panes still
 *  rendering an in-memory copy of a deleted note - the editor only re-evaluates
 *  on `noteId` prop change, and nothing tells it the underlying row is gone.
 *  Cheap when no panes are open; bounded by `MAX_PANES * tabs` even in the
 *  worst case. */
async function pruneOrphanedTabsAgainstBackend(): Promise<void> {
  const open = Array.from(openNoteIds());
  if (open.length === 0) return;
  let alive: string[];
  try {
    alive = await api.notesFilterExisting(open);
  } catch (e) {
    console.warn("pruneOrphanedTabsAgainstBackend: filter failed", e);
    return;
  }
  if (alive.length === open.length) return;
  const validSet = new Set(alive);
  // Cancel any debounced save targeting an orphaned id - otherwise the
  // 350ms timer would fire after we null the tab and surface NotFound.
  for (const id of open) {
    if (!validSet.has(id)) {
      cache.delete(id);
      setMentionStatus(id, "missing");
      for (const tabApi of allTabApis()) tabApi.cancelPendingSave(id);
    }
  }
  reconcileLayoutWithNotes(validSet);
}

/** Load the next page of unpinned items. No-op if there's nothing more.
 *
 * Sliding-window: once the loaded prefix exceeds `ITEMS_SLIDING_WINDOW_MAX`,
 * we keep the trailing `ITEMS_SLIDING_WINDOW_KEEP` and discard the newest
 * items above. The discarded section is recovered by re-loading from the
 * top (refreshNotes) - which the user triggers by scrolling back up. Without
 * this cap, a power user with 1M notes who scrolls forever would accumulate
 * the entire summary list in memory (250 MB+). */
export async function loadMoreNotes() {
  if (state.loadingMore || !state.nextCursor) return;
  setState("loadingMore", true);
  try {
    const page = await api.listNotes(state.nextCursor, PAGE_SIZE, activeFolderFilter());
    setState(
      produce((s) => {
        // Drop the top of the loaded prefix once we exceed the cap. The
        // virtualizer's anchor is its scrollTop, which is unaffected by
        // splicing content the user can't currently see (it sits below
        // the bottom of the viewport, off-screen).
        const newCount = s.items.length + page.items.length;
        if (newCount > ITEMS_SLIDING_WINDOW_MAX) {
          const dropFromTop = newCount - ITEMS_SLIDING_WINDOW_KEEP;
          if (dropFromTop > 0 && dropFromTop < s.items.length) {
            s.items.splice(0, dropFromTop);
          }
        }
        s.items.push(...page.items);
        s.nextCursor = page.next_cursor;
      }),
    );
  } finally {
    setState("loadingMore", false);
  }
}

export async function loadNote(id: string): Promise<Note> {
  const cached = cache.get(id);
  if (cached) return cached;
  const note = await api.getNote(id);
  cache.set(id, note);
  return note;
}

/** Like `loadNote`, but bypasses the cache. Used after a backend mutation
 *  whose effect doesn't flow through `updateNote` (e.g. snapshot restore
 *  rewrites notes.{title,content_*} on the Rust side without going through
 *  our update_note IPC, so the cache + sidebar summary are stale). */
export async function reloadNote(id: string): Promise<Note> {
  const note = await api.getNote(id);
  cache.set(id, note);
  setState(
    produce((s) => {
      const summary = summaryFromNote(note);
      const inItems = s.items.findIndex((n) => n.id === id);
      if (inItems >= 0) s.items[inItems] = summary;
      const inPinned = s.pinned.findIndex((n) => n.id === id);
      if (inPinned >= 0) s.pinned[inPinned] = summary;
    }),
  );
  return note;
}

export function getCachedNote(id: string): Note | undefined {
  return cache.get(id);
}

export function patchCachedNote(note: Note) {
  cache.set(note.id, note);
}

export async function createNote(): Promise<Note> {
  // If a real folder is currently filtered, the new note inherits it so it
  // shows up in the active view. "Inbox" and "All" both produce a note with
  // folder_id = NULL (Inbox is the implicit default).
  const filter = activeFolderFilter();
  const folderId = filter.kind === "folder" ? filter.id : null;
  const note = await api.createNote(folderId);
  cache.set(note.id, note);
  setState(
    produce((s) => {
      s.items.unshift(summaryFromNote(note));
    }),
  );
  bumpFolderNoteCount(folderId, +1);
  return note;
}

/**
 * Save a note. The IPC returns slim sidebar metadata only - we don't ship
 * `content_json` / `content_text` back over the IPC for every keystroke,
 * because the renderer just sent both and they can be MB-sized. The full
 * Note in our local cache is patched in place from `input` (what we sent)
 * + the metadata returned by the backend (canonical title / updated_at /
 * preview). Saves O(content_size) per keystroke burst on big notes.
 */
export async function updateNote(input: UpdateNoteInput): Promise<Note> {
  const summary = await api.updateNote(input);
  // Reconstruct the Note for the cache. We need created_at / deleted_at
  // from the previous cached value (those don't change on save). If there
  // was no cached entry, fall back to a fresh getNote IPC - but that's a
  // cold path (the editor would have loaded the note before triggering a
  // save).
  const cached = cache.get(summary.id);
  const patched: Note = {
    id: summary.id,
    title: summary.title,
    content_json: input.content_json,
    content_text: input.content_text,
    is_pinned: summary.is_pinned,
    pinned_at: summary.pinned_at,
    created_at: cached?.created_at ?? summary.updated_at,
    updated_at: summary.updated_at,
    deleted_at: cached?.deleted_at ?? null,
    folder_id: summary.folder_id,
  };
  cache.set(summary.id, patched);

  let movedOrRebucketed = false;
  setState(
    produce((s) => {
      const list = summary.is_pinned ? s.pinned : s.items;
      const idx = list.findIndex((n) => n.id === summary.id);
      if (idx < 0) return;
      // Mutate the proxy at idx in place. Replacing it with `list[idx] =
      // summary` would orphan the existing proxy, and any consumer that
      // captured the old reference (e.g. a sidebar row's <Show> children
      // closure that read row.note once) would keep showing the old
      // updated_at because the orphaned proxy is no longer tracked. By
      // writing properties on the existing proxy we keep its identity and
      // every reactive read of its updated_at sees the new value.
      const item = list[idx];
      // Compare buckets BEFORE we overwrite updated_at so we still flash
      // the row when the only change is a bucket transition (e.g. the
      // single Yesterday note rolling into Today at idx 0, where the
      // splice/unshift below is skipped).
      const boundaries = summary.is_pinned ? null : bucketBoundaries();
      const bucketChanged =
        boundaries !== null &&
        bucketFor(item.updated_at, boundaries) !== bucketFor(summary.updated_at, boundaries);
      if (item.title !== summary.title) item.title = summary.title;
      // Backend-canonical preview - matches what `make_preview` produces
      // for `list_notes` so save vs. refresh paths can't drift.
      if (item.preview !== summary.preview) item.preview = summary.preview;
      if (item.is_pinned !== summary.is_pinned) item.is_pinned = summary.is_pinned;
      if (item.pinned_at !== summary.pinned_at) item.pinned_at = summary.pinned_at;
      if (item.updated_at !== summary.updated_at) item.updated_at = summary.updated_at;
      // Keep recently-edited unpinned notes near the top of the loaded prefix.
      // Skip when already at idx 0 - the splice/unshift would be a no-op
      // visually but Solid's array reconciliation may still rebuild the
      // proxy at index 0, breaking captured references. (Ordering across
      // the pagination boundary is a server concern; this only fixes the
      // visible window.)
      if (!summary.is_pinned && idx > 0) {
        list.splice(idx, 1);
        list.unshift(item);
        movedOrRebucketed = true;
      } else if (bucketChanged) {
        movedOrRebucketed = true;
      }
    }),
  );
  if (movedOrRebucketed) flashMoved(summary.id);
  return patched;
}

/** Toggle pin without a server round-trip for the list - we know the new state. */
export async function togglePin(id: string): Promise<Note> {
  const note = await api.togglePin(id);
  cache.set(note.id, note);
  setState(
    produce((s) => {
      // Remove from wherever it lived.
      const fromItems = s.items.findIndex((n) => n.id === id);
      if (fromItems >= 0) s.items.splice(fromItems, 1);
      const fromPinned = s.pinned.findIndex((n) => n.id === id);
      if (fromPinned >= 0) s.pinned.splice(fromPinned, 1);

      const summary = summaryFromNote(note);
      if (note.is_pinned) {
        // Newest pinned at top (matches server ORDER BY pinned_at DESC).
        s.pinned.unshift(summary);
      } else {
        s.items.unshift(summary);
      }
    }),
  );
  return note;
}

/** Move a note to a different folder (or to Inbox if `folderId` is null).
 *  Updates folder badge counts in place, patches the loaded summary's
 *  `folder_id`, and removes the note from the visible list if its new
 *  folder is no longer in the active filter's scope. */
export async function moveNoteToFolder(noteId: string, folderId: string | null): Promise<void> {
  // Find the source folder from whichever bucket holds the row right now.
  // We need this before the mutation so the folder-count bump on the source
  // side is correct.
  const summary =
    state.pinned.find((n) => n.id === noteId) ?? state.items.find((n) => n.id === noteId);
  const previousFolderId = summary?.folder_id ?? getCachedNote(noteId)?.folder_id ?? null;
  if (previousFolderId === folderId) return;

  await api.moveNoteToFolder(noteId, folderId);

  bumpFolderNoteCount(previousFolderId, -1);
  bumpFolderNoteCount(folderId, +1);

  // Patch cached note + visible summary in place.
  const cached = cache.get(noteId);
  if (cached) cache.set(noteId, { ...cached, folder_id: folderId });
  const filter = activeFolderFilter();
  const stillVisible = noteFitsFilter(folderId, filter);

  setState(
    produce((s) => {
      const inItems = s.items.findIndex((n) => n.id === noteId);
      const inPinned = s.pinned.findIndex((n) => n.id === noteId);
      if (!stillVisible) {
        if (inItems >= 0) s.items.splice(inItems, 1);
        if (inPinned >= 0) s.pinned.splice(inPinned, 1);
        return;
      }
      if (inItems >= 0) s.items[inItems].folder_id = folderId;
      if (inPinned >= 0) s.pinned[inPinned].folder_id = folderId;
    }),
  );
}

export async function softDeleteNote(id: string): Promise<void> {
  // Capture summary before mutating so we can prepend to trash if loaded.
  const prev = state.pinned.find((n) => n.id === id) ?? state.items.find((n) => n.id === id);
  // Pre-empt any debounced save aimed at this note BEFORE the IPC. If we
  // softDelete first, the still-pending update_note arrives after the row
  // is already deleted_at IS NOT NULL and returns NotFound, surfacing as
  // an error toast. cancelPendingSave is best-effort: an in-flight save is
  // already past the point of no abort, but the next-debounce-tick is.
  for (const tabApi of allTabApis()) {
    tabApi.cancelPendingSave(id);
  }
  await api.softDeleteNote(id);
  // Note's folder loses one active note - decrement the badge so the count
  // stays in sync. Restore() bumps it back.
  bumpFolderNoteCount(prev?.folder_id ?? null, -1);
  cache.delete(id);
  // Any open editor that mentions this note should now show it as trashed.
  setMentionStatus(id, "trashed");
  // Clear any pane showing this note so its editor doesn't keep saving into
  // a trashed row. Same-note guard means at most one pane references the id.
  const showingPane = paneForNote(id);
  if (showingPane) openNoteInPane(showingPane, null);
  const deletedAt = new Date().toISOString();
  setState(
    produce((s) => {
      const fromItems = s.items.findIndex((n) => n.id === id);
      if (fromItems >= 0) s.items.splice(fromItems, 1);
      const fromPinned = s.pinned.findIndex((n) => n.id === id);
      if (fromPinned >= 0) s.pinned.splice(fromPinned, 1);
      if (s.trashLoaded && prev) {
        s.trash.unshift({
          id: prev.id,
          title: prev.title,
          preview: prev.preview,
          updated_at: prev.updated_at,
          deleted_at: deletedAt,
        });
      }
    }),
  );
}

/* ---------------- Trash ---------------- */

export async function loadTrash() {
  const page = await api.listTrash(null, PAGE_SIZE);
  setState(
    produce((s) => {
      s.trash = page.items;
      s.trashCursor = page.next_cursor;
      s.trashLoaded = true;
    }),
  );
}

export async function loadMoreTrash() {
  if (!state.trashCursor) return;
  const page = await api.listTrash(state.trashCursor, PAGE_SIZE);
  setState(
    produce((s) => {
      s.trash = s.trash.concat(page.items);
      s.trashCursor = page.next_cursor;
    }),
  );
}

export async function restoreNote(id: string): Promise<Note> {
  const note = await api.restoreNote(id);
  cache.set(note.id, note);
  setMentionStatus(id, "alive");
  bumpFolderNoteCount(note.folder_id, +1);
  setState(
    produce((s) => {
      const idx = s.trash.findIndex((n) => n.id === id);
      if (idx >= 0) s.trash.splice(idx, 1);
      const summary = summaryFromNote(note);
      // Only show in the visible list if the note's folder fits the active
      // filter - otherwise the user would see it pop into a list it
      // shouldn't belong to.
      if (noteFitsFilter(note.folder_id, activeFolderFilter())) {
        if (note.is_pinned) s.pinned.unshift(summary);
        else s.items.unshift(summary);
      }
    }),
  );
  return note;
}

export async function purgeNote(id: string): Promise<void> {
  // Same reasoning as softDeleteNote: any pending save targeting this id
  // would land NotFound after the purge. Cancel before issuing the IPC.
  for (const tabApi of allTabApis()) {
    tabApi.cancelPendingSave(id);
  }
  await api.purgeNote(id);
  cache.delete(id);
  setMentionStatus(id, "missing");
  // Rare but possible: a trashed note could still be referenced by a tab
  // (e.g. another window restored+trashed it without us hearing). Null any
  // tab pointing at the now-purged id so the picker takes over.
  const showingPane = paneForNote(id);
  if (showingPane) openNoteInPane(showingPane, null);
  setState(
    produce((s) => {
      const idx = s.trash.findIndex((n) => n.id === id);
      if (idx >= 0) s.trash.splice(idx, 1);
    }),
  );
}

export async function emptyTrash(): Promise<number> {
  const n = await api.emptyTrash();
  markAllTrashedAsMissing();
  setState(
    produce((s) => {
      s.trash = [];
      s.trashCursor = null;
    }),
  );
  await pruneOrphanedTabsAgainstBackend();
  return n;
}

/** Hard-delete trashed notes older than N days. Returns the row count.
 *  Like `emptyTrash`, this is a bulk hard-delete - any pane referencing one
 *  of the purged ids would otherwise keep painting it. */
export async function purgeOldTrash(days: number): Promise<number> {
  const n = await api.purgeOldTrash(days);
  if (n > 0) {
    // We don't get the purged id list back, so reconcile against the backend
    // for any currently-open tab. Also drop any now-stale trash summaries the
    // dialog had loaded.
    await Promise.all([loadTrash().catch(() => {}), pruneOrphanedTabsAgainstBackend()]);
  }
  return n;
}

function summaryFromNote(note: Note): NoteSummary {
  return {
    id: note.id,
    title: note.title,
    preview: shortPreview(note.content_text),
    is_pinned: note.is_pinned,
    pinned_at: note.pinned_at,
    updated_at: note.updated_at,
    folder_id: note.folder_id,
  };
}

/**
 * Mirror of Rust-side `make_preview` (db.rs). Single source of truth for the
 * sidebar/command-bar preview format. Keep these two in sync - the post-save
 * IPC delivers the backend-canonical preview already, so this only runs on
 * client-side patches (createNote / restoreNote / togglePin / etc.) where
 * we don't round-trip through the backend just to generate a preview.
 *
 *   - split on '\n'
 *   - trim each line
 *   - drop empty lines
 *   - join with " · "
 *   - truncate to 140 chars (codepoint-counted, not byte-counted)
 */
function shortPreview(text: string): string {
  const PREVIEW_MAX = 140;
  const cleaned = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join(" · ");
  // Iterator-based slice keeps astral codepoints (emoji) intact.
  const codepoints = Array.from(cleaned);
  if (codepoints.length <= PREVIEW_MAX) return cleaned;
  return `${codepoints.slice(0, PREVIEW_MAX).join("")}…`;
}

/** "Selected note" is now derived from the active pane in the panes store -
 *  there's no longer a separate top-level signal. Existing consumers keep
 *  using `selectedId()` / `setSelectedId(id)` and these route through the
 *  active pane. Setting null clears the active pane (used after deleting the
 *  last note). */
export const selectedId = activePaneNoteId;
export function setSelectedId(id: string | null) {
  openNoteInActivePane(id);
}

export const selectedNoteSummary = createMemo(() => {
  const id = activePaneNoteId();
  if (!id) return undefined;
  return state.pinned.find((n) => n.id === id) ?? state.items.find((n) => n.id === id);
});

export function selectFirstAvailable(): string | null {
  const first = state.pinned[0] ?? state.items[0];
  if (first) {
    openNoteInActivePane(first.id);
    return first.id;
  }
  openNoteInActivePane(null);
  return null;
}

export async function ensureSelection(): Promise<string | null> {
  const id = activePaneNoteId();
  if (id && (state.pinned.some((n) => n.id === id) || state.items.some((n) => n.id === id))) {
    return id;
  }
  if (state.pinned.length === 0 && state.items.length === 0) {
    const note = await createNote();
    batch(() => {
      openNoteInActivePane(note.id);
    });
    return note.id;
  }
  return selectFirstAvailable();
}
