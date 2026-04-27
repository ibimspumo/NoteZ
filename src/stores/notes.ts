import { batch, createMemo, createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { api } from "../lib/tauri";
import type { Note, NoteSummary, UpdateNoteInput } from "../lib/types";

type NotesState = {
  list: NoteSummary[];
  loading: boolean;
};

const [state, setState] = createStore<NotesState>({
  list: [],
  loading: false,
});

const cache = new Map<string, Note>();

export const notesState = state;

export async function refreshNotes() {
  setState("loading", true);
  try {
    const list = await api.listNotes(false);
    setState("list", list);
  } finally {
    setState("loading", false);
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
    "list",
    produce((list) => {
      list.unshift({
        id: note.id,
        title: note.title,
        preview: "",
        is_pinned: note.is_pinned,
        pinned_at: note.pinned_at,
        updated_at: note.updated_at,
      });
    }),
  );
  return note;
}

export async function updateNote(input: UpdateNoteInput): Promise<Note> {
  const note = await api.updateNote(input);
  cache.set(note.id, note);
  setState(
    "list",
    produce((list) => {
      const idx = list.findIndex((n) => n.id === note.id);
      if (idx >= 0) {
        list[idx] = {
          id: note.id,
          title: note.title,
          preview: shortPreview(note.content_text),
          is_pinned: note.is_pinned,
          pinned_at: note.pinned_at,
          updated_at: note.updated_at,
        };
      }
    }),
  );
  return note;
}

export async function togglePin(id: string): Promise<Note> {
  const note = await api.togglePin(id);
  cache.set(note.id, note);
  await refreshNotes();
  return note;
}

export async function softDeleteNote(id: string): Promise<void> {
  await api.softDeleteNote(id);
  cache.delete(id);
  setState(
    "list",
    produce((list) => {
      const idx = list.findIndex((n) => n.id === id);
      if (idx >= 0) list.splice(idx, 1);
    }),
  );
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

export const selectedNoteSummary = createMemo(() =>
  state.list.find((n) => n.id === selectedNoteId()),
);

export function selectFirstAvailable(): string | null {
  const first = state.list[0];
  if (first) {
    setSelectedNoteIdRaw(first.id);
    return first.id;
  }
  setSelectedNoteIdRaw(null);
  return null;
}

export async function ensureSelection(): Promise<string | null> {
  if (selectedNoteId() && state.list.some((n) => n.id === selectedNoteId())) {
    return selectedNoteId();
  }
  if (state.list.length === 0) {
    const note = await createNote();
    batch(() => {
      setSelectedNoteIdRaw(note.id);
    });
    return note.id;
  }
  return selectFirstAvailable();
}
