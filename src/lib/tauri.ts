import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { type UnlistenFn, listen } from "@tauri-apps/api/event";
import type {
  AiCallsCursor,
  AiCallsPage,
  AiConfig,
  AiModel,
  AiStats,
  Asset,
  AssetRef,
  DeleteFolderMode,
  Folder,
  FolderFilter,
  MentionTargetStatus,
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
  createNote: (folderId?: string | null) =>
    invoke<Note>("create_note", { folderId: folderId ?? null }),
  getNote: (id: string) => invoke<Note>("get_note", { id }),
  updateNote: (input: UpdateNoteInput) => invoke<Note>("update_note", { input }),
  listNotes: (cursor?: NotesCursor | null, limit?: number, folder?: FolderFilter | null) =>
    invoke<NotesPage>("list_notes", { cursor: cursor ?? null, limit, folder: folder ?? null }),
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
  createSnapshot: (noteId: string, isManual?: boolean, manualLabel?: string) =>
    invoke<Snapshot>("create_snapshot", { noteId, isManual, manualLabel }),
  listSnapshots: (noteId: string, cursor?: SnapshotsCursor | null, limit?: number) =>
    invoke<SnapshotsPage>("list_snapshots", {
      noteId,
      cursor: cursor ?? null,
      limit,
    }),
  restoreSnapshot: (snapshotId: string) => invoke<void>("restore_snapshot", { snapshotId }),

  // mentions
  listBacklinks: (noteId: string) => invoke<NoteSummary[]>("list_backlinks", { noteId }),
  getMentionStatusBulk: (ids: string[]) =>
    invoke<MentionTargetStatus[]>("get_mention_status_bulk", { ids }),

  // folders
  listFolders: () => invoke<Folder[]>("list_folders"),
  createFolder: (name: string, parentId?: string | null) =>
    invoke<Folder>("create_folder", { name, parentId: parentId ?? null }),
  renameFolder: (id: string, name: string) => invoke<Folder>("rename_folder", { id, name }),
  deleteFolder: (id: string, mode?: DeleteFolderMode) =>
    invoke<void>("delete_folder", { id, mode: mode ?? null }),
  moveFolder: (id: string, newParentId: string | null) =>
    invoke<Folder>("move_folder", { id, newParentId }),
  moveNoteToFolder: (noteId: string, folderId: string | null) =>
    invoke<void>("move_note_to_folder", { noteId, folderId }),

  // settings
  getSetting: (key: string) => invoke<string | null>("get_setting", { key }),
  setSetting: (key: string, value: string) => invoke<void>("set_setting", { key, value }),
  listSettings: () => invoke<Array<[string, string]>>("list_settings"),

  // shortcuts (live-mutable global hotkeys)
  getShortcuts: () => invoke<{ quick_capture: string; command_bar: string }>("get_shortcuts"),
  updateShortcut: (name: "quick_capture" | "command_bar", accelerator: string) =>
    invoke<string>("update_shortcut", { name, accelerator }),

  // assets
  saveAsset: (bytes: number[], mime: string) => invoke<AssetRef>("save_asset", { bytes, mime }),
  /** Faster alternative for the drag-from-Finder flow: instead of streaming
   *  millions of bytes through the JSON IPC, we hand the backend a path and
   *  it reads the file off-thread. Used by the Tauri 2 `dropPaths` listener
   *  in the editor. */
  saveAssetFromPath: (path: string, mime: string) =>
    invoke<AssetRef>("save_asset_from_path", { path, mime }),
  getAsset: (id: string) => invoke<AssetRef | null>("get_asset", { id }),
  getAssetsDir: () => invoke<string>("get_assets_dir"),
  listAssets: () => invoke<Asset[]>("list_assets"),
  gcOrphanAssets: () => invoke<number>("gc_orphan_assets"),

  // capture window
  toggleCaptureWindow: () => invoke<void>("toggle_capture_window"),
  hideCaptureWindow: () => invoke<void>("hide_capture_window"),

  // ai
  getAiConfig: () => invoke<AiConfig>("get_ai_config"),
  setAiEnabled: (enabled: boolean) => invoke<void>("set_ai_enabled", { enabled }),
  setAiModel: (model: string) => invoke<void>("set_ai_model", { model }),
  setOpenrouterKey: (key: string) => invoke<void>("set_openrouter_key", { key }),
  listAiModels: (forceRefresh?: boolean) => invoke<AiModel[]>("list_ai_models", { forceRefresh }),
  generateTitle: (text: string, noteId?: string | null) =>
    invoke<string>("generate_title", { text, noteId: noteId ?? null }),
  listAiCalls: (cursor?: AiCallsCursor | null, limit?: number) =>
    invoke<AiCallsPage>("list_ai_calls", { cursor: cursor ?? null, limit }),
  getAiStats: () => invoke<AiStats>("get_ai_stats"),
  clearAiCalls: () => invoke<number>("clear_ai_calls"),

  // dev-only stress-test helpers. The backend commands are #[cfg(debug_assertions)]
  // so these will fail in production builds - callers must gate on import.meta.env.DEV.
  devGenerateNotes: (options: {
    count: number;
    style: "plain" | "mixed" | "long";
    pinPercent: number;
  }) => invoke<number>("dev_generate_notes", { options }),
  devCountGeneratedNotes: () => invoke<number>("dev_count_generated_notes"),
  devDeleteGeneratedNotes: () => invoke<number>("dev_delete_generated_notes"),
  devSeedDemoNotes: () => invoke<number>("dev_seed_demo_notes"),
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

// Dev-only stress-test progress payload, emitted by `dev_generate_notes` /
// `dev_delete_generated_notes`. Listen via `onDevProgress` rather than the
// regular `onEvent` so the payload is typed and the production bundle has
// nothing to listen for.
export type DevProgress = {
  phase: "start" | "progress" | "done";
  done: number;
  total: number;
};

export function onDevProgress(
  kind: "generate" | "delete",
  handler: (p: DevProgress) => void,
): Promise<UnlistenFn> {
  const event =
    kind === "generate" ? "notez://dev/generate-progress" : "notez://dev/delete-progress";
  return listen<DevProgress>(event, (e) => handler(e.payload));
}
