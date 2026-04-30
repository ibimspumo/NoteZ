export type Note = {
  id: string;
  title: string;
  content_json: string;
  content_text: string;
  is_pinned: boolean;
  pinned_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  /** Owning folder id. `null` = Inbox (no folder). */
  folder_id: string | null;
};

export type NoteSummary = {
  id: string;
  title: string;
  preview: string;
  is_pinned: boolean;
  pinned_at: string | null;
  updated_at: string;
  folder_id: string | null;
};

export type SearchHit = {
  id: string;
  title: string;
  snippet: string;
  is_pinned: boolean;
  updated_at: string;
  score: number;
};

export type Snapshot = {
  id: string;
  note_id: string;
  title: string;
  content_json: string;
  content_text: string;
  created_at: string;
  is_manual: boolean;
  manual_label: string | null;
};

export type MentionStatus = "alive" | "trashed" | "missing";

export type MentionTargetStatus = {
  id: string;
  status: MentionStatus;
};

export type UpdateNoteInput = {
  id: string;
  title: string;
  content_json: string;
  content_text: string;
  mention_target_ids: string[];
  asset_ids: string[];
};

export type NotesCursor = {
  updated_at: string;
  id: string;
};

export type NotesPage = {
  pinned: NoteSummary[];
  items: NoteSummary[];
  next_cursor: NotesCursor | null;
};

export type TrashCursor = {
  deleted_at: string;
  id: string;
};

export type TrashSummary = {
  id: string;
  title: string;
  preview: string;
  updated_at: string;
  deleted_at: string;
};

export type TrashPage = {
  items: TrashSummary[];
  next_cursor: TrashCursor | null;
};

export type SnapshotsCursor = {
  created_at: string;
  id: string;
};

export type SnapshotsPage = {
  items: Snapshot[];
  next_cursor: SnapshotsCursor | null;
};

export type Asset = {
  id: string;
  mime: string;
  ext: string;
  width: number;
  height: number;
  blurhash: string | null;
  byte_size: number;
  created_at: string;
};

export type AssetsCursor = {
  created_at: string;
  id: string;
};

export type AssetsPage = {
  items: Asset[];
  next_cursor: AssetsCursor | null;
};

export type BacklinksCursor = {
  updated_at: string;
  id: string;
};

export type BacklinksPage = {
  items: NoteSummary[];
  next_cursor: BacklinksCursor | null;
};

export type AssetRef = {
  id: string;
  mime: string;
  width: number;
  height: number;
  blurhash: string | null;
  byte_size: number;
  /** Absolute on-disk path. Use `convertFileSrc()` from `@tauri-apps/api/core` to get a webview-loadable URL. */
  path: string;
};

export type AiConfig = {
  enabled: boolean;
  has_key: boolean;
  model: string;
};

export type AiModel = {
  id: string;
  name: string;
  context_length: number;
  /** USD per 1M prompt tokens. */
  prompt_per_m: number;
  /** USD per 1M completion tokens. */
  completion_per_m: number;
};

export type AiCallStatus = "ok" | "error";

export type AiCall = {
  id: string;
  created_at: string;
  model: string;
  purpose: string;
  note_id: string | null;
  note_title: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number;
  duration_ms: number;
  status: AiCallStatus;
  error: string | null;
};

export type AiCallsCursor = {
  created_at: string;
  id: string;
};

export type AiCallsPage = {
  items: AiCall[];
  next_cursor: AiCallsCursor | null;
};

export type AiStats = {
  total_calls: number;
  total_cost_usd: number;
  error_calls: number;
};

export type Folder = {
  id: string;
  parent_id: string | null;
  name: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
  /** Direct note count (notes whose folder_id == this folder, excluding trashed). */
  note_count: number;
};

/** Folder filter passed to `list_notes`. Mirrors the Rust enum:
 *   - `all`    - no folder filter (default)
 *   - `inbox`  - only notes with no folder
 *   - `folder` - notes inside this folder, optionally including descendants */
export type FolderFilter =
  | { kind: "all" }
  | { kind: "inbox" }
  | { kind: "folder"; id: string; include_descendants?: boolean };

/** What `delete_folder` should do with the contents of the folder:
 *   - `reparent_to_parent` - everything moves up one level (legacy default)
 *   - `reparent_to`        - everything moves into a specific folder
 *                            (folder_id = null means Inbox / root)
 *   - `trash_notes`        - notes go to Trash, subfolders are wiped */
export type DeleteFolderMode =
  | { kind: "reparent_to_parent" }
  | { kind: "reparent_to"; folder_id: string | null }
  | { kind: "trash_notes" };
