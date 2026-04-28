import { batch, createMemo, createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { api } from "../lib/tauri";
import type {
  Note,
  NoteSummary,
  NotesCursor,
  TrashCursor,
  TrashSummary,
  UpdateNoteInput,
} from "../lib/types";

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

const PAGE_SIZE = 100;

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

const cache = new Map<string, Note>();

export const notesState = state;

/** First-page load. Replaces both pinned + items. */
export async function refreshNotes() {
  const page = await api.listNotes(null, PAGE_SIZE);
  setState(
    produce((s) => {
      s.pinned = page.pinned;
      s.items = page.items;
      s.nextCursor = page.next_cursor;
      s.initialLoaded = true;
    }),
  );
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
  await refreshNotes();
}

/** Load the next page of unpinned items. No-op if there's nothing more. */
export async function loadMoreNotes() {
  if (state.loadingMore || !state.nextCursor) return;
  setState("loadingMore", true);
  try {
    const page = await api.listNotes(state.nextCursor, PAGE_SIZE);
    setState(
      produce((s) => {
        s.items = s.items.concat(page.items);
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

export function getCachedNote(id: string): Note | undefined {
  return cache.get(id);
}

export function patchCachedNote(note: Note) {
  cache.set(note.id, note);
}

export async function createNote(): Promise<Note> {
  const note = await api.createNote();
  cache.set(note.id, note);
  setState(
    produce((s) => {
      s.items.unshift(summaryFromNote(note));
    }),
  );
  return note;
}

export async function updateNote(input: UpdateNoteInput): Promise<Note> {
  const note = await api.updateNote(input);
  cache.set(note.id, note);
  setState(
    produce((s) => {
      const list = note.is_pinned ? s.pinned : s.items;
      const idx = list.findIndex((n) => n.id === note.id);
      const summary = summaryFromNote(note);
      if (idx >= 0) {
        list[idx] = summary;
        // Keep recently-edited unpinned notes near the top of the loaded prefix.
        // (Ordering across the pagination boundary is a server concern; this
        // only fixes the visible window.)
        if (!note.is_pinned) {
          list.splice(idx, 1);
          list.unshift(summary);
        }
      }
    }),
  );
  return note;
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

export async function softDeleteNote(id: string): Promise<void> {
  // Capture summary before mutating so we can prepend to trash if loaded.
  const prev =
    state.pinned.find((n) => n.id === id) ?? state.items.find((n) => n.id === id);
  await api.softDeleteNote(id);
  cache.delete(id);
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
  setState(
    produce((s) => {
      const idx = s.trash.findIndex((n) => n.id === id);
      if (idx >= 0) s.trash.splice(idx, 1);
      const summary = summaryFromNote(note);
      if (note.is_pinned) s.pinned.unshift(summary);
      else s.items.unshift(summary);
    }),
  );
  return note;
}

export async function purgeNote(id: string): Promise<void> {
  await api.purgeNote(id);
  setState(
    produce((s) => {
      const idx = s.trash.findIndex((n) => n.id === id);
      if (idx >= 0) s.trash.splice(idx, 1);
    }),
  );
}

export async function emptyTrash(): Promise<number> {
  const n = await api.emptyTrash();
  setState(
    produce((s) => {
      s.trash = [];
      s.trashCursor = null;
    }),
  );
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
  };
}

function shortPreview(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= 140) return oneLine;
  return oneLine.slice(0, 140) + "…";
}

const [selectedNoteId, setSelectedNoteIdRaw] = createSignal<string | null>(null);

export const selectedId = selectedNoteId;
export function setSelectedId(id: string | null) {
  setSelectedNoteIdRaw(id);
}

export const selectedNoteSummary = createMemo(() => {
  const id = selectedNoteId();
  if (!id) return undefined;
  return state.pinned.find((n) => n.id === id) ?? state.items.find((n) => n.id === id);
});

export function selectFirstAvailable(): string | null {
  const first = state.pinned[0] ?? state.items[0];
  if (first) {
    setSelectedNoteIdRaw(first.id);
    return first.id;
  }
  setSelectedNoteIdRaw(null);
  return null;
}

export async function ensureSelection(): Promise<string | null> {
  const id = selectedNoteId();
  if (
    id &&
    (state.pinned.some((n) => n.id === id) || state.items.some((n) => n.id === id))
  ) {
    return id;
  }
  if (state.pinned.length === 0 && state.items.length === 0) {
    const note = await createNote();
    batch(() => {
      setSelectedNoteIdRaw(note.id);
    });
    return note.id;
  }
  return selectFirstAvailable();
}
