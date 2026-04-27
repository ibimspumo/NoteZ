import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  Note,
  NoteSummary,
  SearchHit,
  Snapshot,
  UpdateNoteInput,
} from "./types";

export const api = {
  // notes
  createNote: () => invoke<Note>("create_note"),
  getNote: (id: string) => invoke<Note>("get_note", { id }),
  updateNote: (input: UpdateNoteInput) =>
    invoke<Note>("update_note", { input }),
  listNotes: (includeDeleted = false) =>
    invoke<NoteSummary[]>("list_notes", { includeDeleted }),
  listTrash: () => invoke<NoteSummary[]>("list_trash"),
  togglePin: (id: string) => invoke<Note>("toggle_pin", { id }),
  softDeleteNote: (id: string) => invoke<void>("soft_delete_note", { id }),
  restoreNote: (id: string) => invoke<Note>("restore_note", { id }),
  purgeNote: (id: string) => invoke<void>("purge_note", { id }),
  emptyTrash: () => invoke<number>("empty_trash"),
  purgeOldTrash: (days: number) => invoke<number>("purge_old_trash", { days }),

  // search
  searchNotes: (query: string, limit?: number) =>
    invoke<SearchHit[]>("search_notes", { query, limit }),
  quickLookup: (query: string, limit?: number) =>
    invoke<SearchHit[]>("quick_lookup", { query, limit }),

  // snapshots
  createSnapshot: (
    noteId: string,
    isManual?: boolean,
    manualLabel?: string,
  ) =>
    invoke<Snapshot>("create_snapshot", { noteId, isManual, manualLabel }),
  listSnapshots: (noteId: string) =>
    invoke<Snapshot[]>("list_snapshots", { noteId }),
  restoreSnapshot: (snapshotId: string) =>
    invoke<void>("restore_snapshot", { snapshotId }),

  // mentions
  listBacklinks: (noteId: string) =>
    invoke<NoteSummary[]>("list_backlinks", { noteId }),

  // settings
  getSetting: (key: string) => invoke<string | null>("get_setting", { key }),
  setSetting: (key: string, value: string) =>
    invoke<void>("set_setting", { key, value }),

  // capture window
  toggleCaptureWindow: () => invoke<void>("toggle_capture_window"),
  hideCaptureWindow: () => invoke<void>("hide_capture_window"),
};

export type NoteZEvent =
  | "notez://global/quick-capture"
  | "notez://global/command-bar";

export function onEvent(event: NoteZEvent, handler: () => void): Promise<UnlistenFn> {
  return listen(event, handler);
}
