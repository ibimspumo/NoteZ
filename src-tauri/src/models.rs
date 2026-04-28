use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Note {
    pub id: String,
    pub title: String,
    pub content_json: String,
    pub content_text: String,
    pub is_pinned: bool,
    pub pinned_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteSummary {
    pub id: String,
    pub title: String,
    pub preview: String,
    pub is_pinned: bool,
    pub pinned_at: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchHit {
    pub id: String,
    pub title: String,
    pub snippet: String,
    pub is_pinned: bool,
    pub updated_at: String,
    pub score: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snapshot {
    pub id: String,
    pub note_id: String,
    pub title: String,
    pub content_json: String,
    pub content_text: String,
    pub created_at: String,
    pub is_manual: bool,
    pub manual_label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateNoteInput {
    pub id: String,
    pub title: String,
    pub content_json: String,
    pub content_text: String,
    pub mention_target_ids: Vec<String>,
    /// Asset IDs (sha256) referenced by this note's editor state. Used to keep
    /// the asset GC safe — assets that drop to zero references can be purged.
    #[serde(default)]
    pub asset_ids: Vec<String>,
}

/// Cursor-paginated page of notes. Pinned notes are returned in full on the first
/// page only (count is small in practice — bounded by user behaviour, not corpus
/// size). Unpinned notes are paginated by `(updated_at, id)` so the cursor stays
/// stable across edits.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotesPage {
    pub pinned: Vec<NoteSummary>,
    pub items: Vec<NoteSummary>,
    pub next_cursor: Option<NotesCursor>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotesCursor {
    pub updated_at: String,
    pub id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrashSummary {
    pub id: String,
    pub title: String,
    pub preview: String,
    pub updated_at: String,
    pub deleted_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrashPage {
    pub items: Vec<TrashSummary>,
    pub next_cursor: Option<TrashCursor>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrashCursor {
    pub deleted_at: String,
    pub id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotsPage {
    pub items: Vec<Snapshot>,
    pub next_cursor: Option<SnapshotsCursor>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotsCursor {
    pub created_at: String,
    pub id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Asset {
    pub id: String,
    pub mime: String,
    pub ext: String,
    pub width: u32,
    pub height: u32,
    pub blurhash: Option<String>,
    pub byte_size: u64,
    pub created_at: String,
}

/// Returned by `save_asset` — what the editor needs to render the image.
/// `path` is the absolute on-disk path; the frontend feeds it through Tauri's
/// `convertFileSrc()` to build a webview-loadable URL.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssetRef {
    pub id: String,
    pub mime: String,
    pub width: u32,
    pub height: u32,
    pub blurhash: Option<String>,
    pub byte_size: u64,
    pub path: String,
}
