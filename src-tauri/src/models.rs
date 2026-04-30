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
    pub folder_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteSummary {
    pub id: String,
    pub title: String,
    pub preview: String,
    pub is_pinned: bool,
    pub pinned_at: Option<String>,
    pub updated_at: String,
    /// Owning folder id (None = Inbox). The frontend reads this to keep
    /// per-folder counts accurate after a move and to decide whether a
    /// row should remain in the visible list when the active filter
    /// excludes the new folder.
    pub folder_id: Option<String>,
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

/// Live status of a mention target. The frontend uses this to paint broken
/// (`missing`) and trashed (`trashed`) mention pills differently from live
/// ones (`alive`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MentionTargetStatus {
    pub id: String,
    /// One of `"alive"`, `"trashed"`, `"missing"`.
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateNoteInput {
    pub id: String,
    pub title: String,
    pub content_json: String,
    pub content_text: String,
    pub mention_target_ids: Vec<String>,
    /// Asset IDs (sha256) referenced by this note's editor state. Used to keep
    /// the asset GC safe - assets that drop to zero references can be purged.
    #[serde(default)]
    pub asset_ids: Vec<String>,
}

/// Cursor-paginated page of notes. Pinned notes are returned in full on the first
/// page only (count is small in practice - bounded by user behaviour, not corpus
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

/// A folder in the notes hierarchy. Folders form a tree via `parent_id`
/// (NULL = root). `sort_order` is a per-parent integer so siblings can be
/// reordered without renumbering the whole tree; ties break alphabetically
/// by name.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Folder {
    pub id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
    /// Count of active (non-trashed) notes whose `folder_id` is exactly this
    /// folder. Subfolder notes are NOT included - the sidebar adds those up
    /// itself when rendering, so the same counts can drive both the
    /// per-row badge and an "include descendants" rollup.
    pub note_count: u32,
}

/// Filter passed to `list_notes` to scope the listing by folder.
///
///  - `All`     - no folder filter (legacy behaviour)
///  - `Inbox`   - only notes with `folder_id IS NULL`
///  - `Folder { id, include_descendants }` - notes in this folder and
///    optionally its descendant folders
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FolderFilter {
    #[default]
    All,
    Inbox,
    Folder {
        id: String,
        #[serde(default = "default_true")]
        include_descendants: bool,
    },
}

fn default_true() -> bool {
    true
}

/// What `delete_folder` should do with the contents (notes + subfolders) of
/// the folder being deleted.
///
///  - `ReparentToParent` (default, legacy behaviour) - everything moves up
///    one level. Safest. Subfolders inherit the deleted folder's parent;
///    notes inherit it too. If the deleted folder was a root-level folder,
///    contents land at the root (notes -> Inbox).
///  - `ReparentTo { folder_id }` - everything moves into a specific folder
///    chosen by the user. `folder_id = None` is equivalent to "Inbox" for
///    notes, and "root" for subfolders. Refuses a destination that is the
///    folder being deleted or one of its descendants (would create a cycle).
///  - `TrashNotes` - the destructive option: all notes in this folder *and*
///    its descendant folders get soft-deleted (visible in Trash). All those
///    folders themselves are then removed. Treats the whole subtree as a
///    unit so the user doesn't end up with empty subfolders.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DeleteFolderMode {
    #[default]
    ReparentToParent,
    ReparentTo {
        #[serde(default)]
        folder_id: Option<String>,
    },
    TrashNotes,
}

/// Returned by `save_asset` - what the editor needs to render the image.
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
