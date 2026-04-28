import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  Asset,
  AssetRef,
  Note,
  NoteSummary,
  NotesCursor,
  NotesPage,
  SearchHit,
  Snapshot,
  SnapshotsCursor,
  SnapshotsPage,
  TrashCursor,
  TrashPage,
  UpdateNoteInput,
} from "./types";

export const api = {
  // notes
  createNote: () => invoke<Note>("create_note"),
  getNote: (id: string) => invoke<Note>("get_note", { id }),
  updateNote: (input: UpdateNoteInput) =>
    invoke<Note>("update_note", { input }),
  listNotes: (cursor?: NotesCursor | null, limit?: number) =>
    invoke<NotesPage>("list_notes", { cursor: cursor ?? null, limit }),
  listTrash: (cursor?: TrashCursor | null, limit?: number) =>
    invoke<TrashPage>("list_trash", { cursor: cursor ?? null, limit }),
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
  listSnapshots: (
    noteId: string,
    cursor?: SnapshotsCursor | null,
    limit?: number,
  ) =>
    invoke<SnapshotsPage>("list_snapshots", {
      noteId,
      cursor: cursor ?? null,
      limit,
    }),
  restoreSnapshot: (snapshotId: string) =>
    invoke<void>("restore_snapshot", { snapshotId }),

  // mentions
  listBacklinks: (noteId: string) =>
    invoke<NoteSummary[]>("list_backlinks", { noteId }),

  // settings
  getSetting: (key: string) => invoke<string | null>("get_setting", { key }),
  setSetting: (key: string, value: string) =>
    invoke<void>("set_setting", { key, value }),
  listSettings: () => invoke<Array<[string, string]>>("list_settings"),

  // shortcuts (live-mutable global hotkeys)
  getShortcuts: () =>
    invoke<{ quick_capture: string; command_bar: string }>("get_shortcuts"),
  updateShortcut: (name: "quick_capture" | "command_bar", accelerator: string) =>
    invoke<string>("update_shortcut", { name, accelerator }),

  // assets
  saveAsset: (bytes: number[], mime: string) =>
    invoke<AssetRef>("save_asset", { bytes, mime }),
  getAsset: (id: string) => invoke<AssetRef | null>("get_asset", { id }),
  getAssetsDir: () => invoke<string>("get_assets_dir"),
  listAssets: () => invoke<Asset[]>("list_assets"),
  gcOrphanAssets: () => invoke<number>("gc_orphan_assets"),

  // capture window
  toggleCaptureWindow: () => invoke<void>("toggle_capture_window"),
  hideCaptureWindow: () => invoke<void>("hide_capture_window"),
};

/** Convert an absolute on-disk asset path to a webview-loadable URL. */
export function assetUrl(absolutePath: string): string {
  return convertFileSrc(absolutePath);
}

export type NoteZEvent =
  | "notez://global/quick-capture"
  | "notez://global/command-bar"
  | "notez://notes/changed";

export function onEvent(event: NoteZEvent, handler: () => void): Promise<UnlistenFn> {
  return listen(event, handler);
}
