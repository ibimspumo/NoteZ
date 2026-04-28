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
};

export type NoteSummary = {
  id: string;
  title: string;
  preview: string;
  is_pinned: boolean;
  pinned_at: string | null;
  updated_at: string;
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
