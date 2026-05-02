use crate::constants::{
    DEFAULT_PAGE_SIZE, MAX_ASSET_REFS_PER_NOTE, MAX_MENTION_TARGETS_PER_NOTE,
    MAX_NOTE_JSON_BYTES, MAX_NOTE_TEXT_BYTES, MAX_PAGE_SIZE, MAX_PINNED, PREVIEW_MAX_CHARS,
};
use crate::db::{make_preview, note_row_to_summary, now_iso, wal_checkpoint, Db};
use crate::error::{NoteZError, Result};
use crate::models::{
    FolderFilter, Note, NoteSummary, NotesCursor, NotesPage, TrashCursor, TrashPage,
    TrashSummary, UpdateNoteInput,
};
use crate::pagination::{collect_page, next_cursor};
use rusqlite::types::Value;
use rusqlite::Connection;
use tauri::State;
use uuid::Uuid;

/// Pre-resolved folder filter, ready to splice into a SQL WHERE clause.
/// `Inbox` becomes `folder_id IS NULL`, `Set` becomes `folder_id IN (?, ?, ...)`,
/// an empty `Set` short-circuits to "no rows" (the asked-for folder doesn't
/// exist). Built once per request so a list call doesn't re-walk the folder
/// tree for both the pinned and the unpinned subqueries.
enum FolderScope {
    All,
    Inbox,
    Set(Vec<String>),
}

#[tauri::command]
pub fn create_note(db: State<Db>, folder_id: Option<String>) -> Result<Note> {
    let conn = db.conn()?;
    if let Some(fid) = folder_id.as_ref() {
        let exists: i64 = conn
            .query_row(
                "SELECT COUNT(1) FROM folders WHERE id = ?1",
                rusqlite::params![fid],
                |r| r.get(0),
            )
            .unwrap_or(0);
        if exists == 0 {
            return Err(NoteZError::NotFound(fid.clone()));
        }
    }
    let id = Uuid::new_v4().to_string();
    let now = now_iso();
    conn.execute(
        "INSERT INTO notes (id, title, content_json, content_text, folder_id, created_at, updated_at)
         VALUES (?1, '', '{}', '', ?2, ?3, ?3)",
        rusqlite::params![id, folder_id, now],
    )?;
    fetch_note(&conn, &id)
}

#[tauri::command]
pub fn get_note(db: State<Db>, id: String) -> Result<Note> {
    let conn = db.conn()?;
    fetch_note(&conn, &id)
}

/// Returns the slim metadata for a saved note. We intentionally do NOT echo
/// the `content_json` / `content_text` fields back: the renderer just sent
/// them and already has them in memory, and on a multi-MB note that's the
/// dominant bandwidth cost of the IPC. The frontend patches its in-memory
/// cache with the values it had + the new metadata it gets back here.
#[tauri::command]
pub fn update_note(db: State<Db>, input: UpdateNoteInput) -> Result<NoteSummary> {
    // Defense-in-depth: reject pathological inputs at the IPC boundary so a
    // buggy/compromised renderer can't blow up SQLite or the FTS index.
    if input.content_text.len() > MAX_NOTE_TEXT_BYTES {
        return Err(NoteZError::InvalidInput(format!(
            "note content_text too large ({} bytes, max {MAX_NOTE_TEXT_BYTES})",
            input.content_text.len()
        )));
    }
    if input.content_json.len() > MAX_NOTE_JSON_BYTES {
        return Err(NoteZError::InvalidInput(format!(
            "note content_json too large ({} bytes, max {MAX_NOTE_JSON_BYTES})",
            input.content_json.len()
        )));
    }
    if input.mention_target_ids.len() > MAX_MENTION_TARGETS_PER_NOTE {
        return Err(NoteZError::InvalidInput(format!(
            "too many mention targets ({}, max {MAX_MENTION_TARGETS_PER_NOTE})",
            input.mention_target_ids.len()
        )));
    }
    if input.asset_ids.len() > MAX_ASSET_REFS_PER_NOTE {
        return Err(NoteZError::InvalidInput(format!(
            "too many asset references ({}, max {MAX_ASSET_REFS_PER_NOTE})",
            input.asset_ids.len()
        )));
    }

    let mut conn = db.conn()?;
    let tx = conn.transaction()?;

    let now = now_iso();
    // Tolerant update: a save can race against a soft-delete (Cmd+Shift+
    // Backspace + late-debounce). Previously the `AND deleted_at IS NULL`
    // gate produced a NotFound error toast on a delete the user just asked
    // for. We now update the row regardless of trash state - the trash UI
    // re-shows the row's metadata, the FTS row stays in sync, and the user
    // doesn't see a phantom "Saving failed". Truly-purged rows still hit
    // the `updated == 0` path below and surface NotFound, which is the
    // correct signal for "this note no longer exists".
    let updated = tx.execute(
        "UPDATE notes SET title = ?1, content_json = ?2, content_text = ?3, updated_at = ?4
         WHERE id = ?5",
        rusqlite::params![input.title, input.content_json, input.content_text, now, input.id],
    )?;
    if updated == 0 {
        return Err(NoteZError::NotFound(input.id.clone()));
    }

    tx.execute("DELETE FROM mentions WHERE source_note_id = ?1", rusqlite::params![input.id])?;
    if !input.mention_target_ids.is_empty() {
        // Bulk insert via json_each: one round-trip even for hundreds of
        // mentions on a single index-style note. The previous per-target
        // SELECT+INSERT was 2N statements; this is 1.
        //
        // Pre-filter by UUID-shape: a malicious / buggy renderer can't waste
        // FK-trip cycles by sending arbitrary 1 KB strings. UUIDs only.
        let cleaned: Vec<&str> = input
            .mention_target_ids
            .iter()
            .filter(|t| t.as_str() != input.id.as_str())
            .filter(|t| Uuid::parse_str(t).is_ok())
            .map(|s| s.as_str())
            .collect();
        if !cleaned.is_empty() {
            let json = serde_json::to_string(&cleaned)?;
            tx.execute(
                "INSERT OR IGNORE INTO mentions (source_note_id, target_note_id, created_at)
                 SELECT ?1, value, ?2
                 FROM json_each(?3)
                 WHERE EXISTS(
                     SELECT 1 FROM notes
                     WHERE id = json_each.value AND deleted_at IS NULL
                 )",
                rusqlite::params![input.id, now, json],
            )?;
        }
    }

    // Replace this note's asset references in `note_assets`. The editor's
    // `editorRefs` mutation listener tracks ImageNode keys incrementally and
    // delivers the deduplicated asset id set in `input.asset_ids`, so we just
    // mirror it. This is the structural replacement for the old O(content_bytes)
    // Aho-Corasick scan in `gc_orphan_assets`.
    tx.execute(
        "DELETE FROM note_assets WHERE note_id = ?1",
        rusqlite::params![input.id],
    )?;
    if !input.asset_ids.is_empty() {
        // Asset ids are sha256 hex strings - filter to that shape so a
        // compromised renderer can't poke at FK-validated SQL.
        let cleaned: Vec<&str> = input
            .asset_ids
            .iter()
            .filter(|s| s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit()))
            .map(|s| s.as_str())
            .collect();
        if !cleaned.is_empty() {
            let json = serde_json::to_string(&cleaned)?;
            tx.execute(
                "INSERT OR IGNORE INTO note_assets (note_id, asset_id)
                 SELECT ?1, value
                 FROM json_each(?2)
                 WHERE EXISTS(SELECT 1 FROM assets WHERE id = json_each.value)",
                rusqlite::params![input.id, json],
            )?;
        }
    }

    tx.commit()?;
    fetch_note_summary(&conn, &input.id)
}

/// Paginated active-notes listing.
///
/// First page (cursor=None) returns pinned items in full - pinned counts are
/// bounded by user behaviour so we don't paginate them. Following pages return
/// only unpinned items, ordered by `updated_at DESC, id DESC` for cursor stability
/// when several notes share the same timestamp.
#[tauri::command]
pub fn list_notes(
    db: State<Db>,
    cursor: Option<NotesCursor>,
    limit: Option<u32>,
    folder: Option<FolderFilter>,
) -> Result<NotesPage> {
    let conn = db.conn()?;
    let limit = clamp_limit(limit, DEFAULT_PAGE_SIZE);
    let scope = resolve_folder_scope(&conn, &folder.unwrap_or_default())?;

    // Pinned notes only on the first page.
    let pinned = if cursor.is_none() {
        load_pinned_summaries(&conn, &scope)?
    } else {
        Vec::new()
    };

    let (items, has_more) = load_unpinned_page(&conn, cursor.as_ref(), limit, &scope)?;
    let next = next_cursor(&items, has_more, |last| NotesCursor {
        updated_at: last.updated_at.clone(),
        id: last.id.clone(),
    });

    Ok(NotesPage { pinned, items, next_cursor: next })
}

#[tauri::command]
pub fn list_trash(
    db: State<Db>,
    cursor: Option<TrashCursor>,
    limit: Option<u32>,
) -> Result<TrashPage> {
    let conn = db.conn()?;
    let limit = clamp_limit(limit, DEFAULT_PAGE_SIZE);

    // Trash uses a separate cursor (deleted_at instead of updated_at).
    // The partial index `idx_notes_trash_deleted` makes this a covered range scan.
    let map_row = |row: &rusqlite::Row<'_>| -> rusqlite::Result<TrashSummary> {
        let content_text: String = row.get("content_text")?;
        Ok(TrashSummary {
            id: row.get("id")?,
            title: row.get("title")?,
            preview: make_preview(&content_text, PREVIEW_MAX_CHARS),
            updated_at: row.get("updated_at")?,
            deleted_at: row.get("deleted_at")?,
        })
    };
    let fetch = (limit + 1) as i64;

    let (items, has_more) = if let Some(c) = cursor.as_ref() {
        let mut stmt = conn.prepare(
            "SELECT id, title, content_text, updated_at, deleted_at
             FROM notes
             WHERE deleted_at IS NOT NULL
               AND (deleted_at, id) < (?1, ?2)
             ORDER BY deleted_at DESC, id DESC
             LIMIT ?3",
        )?;
        collect_page(
            &mut stmt,
            rusqlite::params![c.deleted_at, c.id, fetch],
            limit,
            map_row,
        )?
    } else {
        let mut stmt = conn.prepare(
            "SELECT id, title, content_text, updated_at, deleted_at
             FROM notes
             WHERE deleted_at IS NOT NULL
             ORDER BY deleted_at DESC, id DESC
             LIMIT ?1",
        )?;
        collect_page(&mut stmt, rusqlite::params![fetch], limit, map_row)?
    };

    let next = next_cursor(&items, has_more, |t| TrashCursor {
        deleted_at: t.deleted_at.clone(),
        id: t.id.clone(),
    });

    Ok(TrashPage { items, next_cursor: next })
}

#[tauri::command]
pub fn toggle_pin(db: State<Db>, id: String) -> Result<Note> {
    let conn = db.conn()?;
    let now = now_iso();
    let updated = conn.execute(
        "UPDATE notes SET
            is_pinned = CASE WHEN is_pinned = 1 THEN 0 ELSE 1 END,
            pinned_at = CASE WHEN is_pinned = 1 THEN NULL ELSE ?1 END,
            updated_at = updated_at
         WHERE id = ?2",
        rusqlite::params![now, id],
    )?;
    if updated == 0 {
        return Err(NoteZError::NotFound(id));
    }
    fetch_note(&conn, &id)
}

#[tauri::command]
pub fn soft_delete_note(db: State<Db>, id: String) -> Result<()> {
    let conn = db.conn()?;
    let now = now_iso();
    let updated = conn.execute(
        "UPDATE notes SET deleted_at = ?1, is_pinned = 0, pinned_at = NULL WHERE id = ?2 AND deleted_at IS NULL",
        rusqlite::params![now, id],
    )?;
    if updated == 0 {
        return Err(NoteZError::NotFound(id));
    }
    Ok(())
}

#[tauri::command]
pub fn restore_note(db: State<Db>, id: String) -> Result<Note> {
    let conn = db.conn()?;
    let updated = conn.execute(
        "UPDATE notes SET deleted_at = NULL WHERE id = ?1 AND deleted_at IS NOT NULL",
        rusqlite::params![id],
    )?;
    if updated == 0 {
        return Err(NoteZError::NotFound(id));
    }
    fetch_note(&conn, &id)
}

#[tauri::command]
pub fn purge_note(db: State<Db>, id: String) -> Result<()> {
    let conn = db.conn()?;
    conn.execute("DELETE FROM notes WHERE id = ?1", rusqlite::params![id])?;
    Ok(())
}

/// Return the subset of `ids` that still exist as alive (non-trashed) notes.
/// Used by the frontend to prune the panes layout after bulk hard-deletes
/// (`empty_trash`, `purge_old_trash`, dev "delete all generated") - any tab
/// referencing an id that's no longer in the result set has its noteId
/// nulled so the empty picker takes over instead of an editor stuck on a
/// row that's gone from the DB.
///
/// Chunked at 500 ids per query to stay well under SQLite's bind-parameter
/// cap (default 32k since 3.32, but we don't want to lean on that). The
/// realistic upper bound is `MAX_PANES (8) × tabs-per-pane`, so a single
/// chunk is almost always enough.
#[tauri::command]
pub fn notes_filter_existing(db: State<Db>, ids: Vec<String>) -> Result<Vec<String>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    const CHUNK: usize = 500;
    let conn = db.conn()?;
    let mut alive: Vec<String> = Vec::with_capacity(ids.len());
    for chunk in ids.chunks(CHUNK) {
        let placeholders = vec!["?"; chunk.len()].join(",");
        let sql = format!(
            "SELECT id FROM notes WHERE deleted_at IS NULL AND id IN ({})",
            placeholders
        );
        let mut stmt = conn.prepare(&sql)?;
        let params: Vec<Value> = chunk.iter().map(|s| Value::from(s.clone())).collect();
        let rows = stmt.query_map(rusqlite::params_from_iter(params), |r| r.get::<_, String>(0))?;
        for r in rows {
            alive.push(r?);
        }
    }
    Ok(alive)
}

/// Batch size for bulk-delete loops in `empty_trash` / `purge_old_trash`.
/// Each chunk commits before the next starts so writers (save pipeline,
/// folder mutations) can interleave instead of waiting on a multi-second
/// transaction at 100k+ rows. The FTS5 trigger fires once per row, so per-
/// chunk overhead is fixed - smaller CHUNK = more interleave but more
/// transactions; 250 mirrors the dev_generate_notes batch size that's
/// already proven on-target.
const TRASH_DELETE_CHUNK: i64 = 250;

#[tauri::command]
pub fn empty_trash(db: State<Db>) -> Result<u64> {
    let mut conn = db.conn()?;
    let mut total: u64 = 0;
    loop {
        let tx = conn.transaction()?;
        let n = tx.execute(
            "DELETE FROM notes
             WHERE id IN (
                 SELECT id FROM notes
                 WHERE deleted_at IS NOT NULL
                 LIMIT ?1
             )",
            rusqlite::params![TRASH_DELETE_CHUNK],
        )?;
        tx.commit()?;
        if n == 0 {
            break;
        }
        total += n as u64;
    }
    drop(conn);
    // Bulk delete - reclaim WAL pages so the working set doesn't bloat
    // (FTS triggers fired per row, that's a lot of journal traffic).
    let _ = wal_checkpoint(&db);
    Ok(total)
}

/// Purge soft-deleted notes older than `days` days.
///
/// `days == 0` is rejected as a mistake at the IPC boundary - the frontend
/// already gates on this, but accepting 0 here would silently delete the
/// entire trash on any future caller.
///
/// The comparison uses `julianday()` rather than `datetime('now', ...)` -
/// `deleted_at` is RFC3339 (`2026-04-29T10:00:00+00:00`) and `datetime('now', ...)`
/// returns SQL-format (`2026-03-30 10:00:00`). String comparison between the
/// two is wrong because `T` (0x54) > space (0x20) - bug observed at exact day
/// boundaries. `julianday()` parses both formats to a numeric Julian day and
/// compares them as numbers, which is unambiguously correct.
#[tauri::command]
pub fn purge_old_trash(db: State<Db>, days: u32) -> Result<u64> {
    if days == 0 {
        return Err(NoteZError::InvalidInput(
            "purge_old_trash: days must be > 0 (use empty_trash to delete all)".into(),
        ));
    }
    // Same batching reasoning as `empty_trash`: a single huge DELETE locks the
    // writer for the full FTS-trigger fan-out at 100k+ stale rows. Chunked
    // commits let the save pipeline interleave.
    let cutoff_offset = format!("-{} days", days);
    let mut conn = db.conn()?;
    let mut total: u64 = 0;
    loop {
        let tx = conn.transaction()?;
        let n = tx.execute(
            "DELETE FROM notes
             WHERE id IN (
                 SELECT id FROM notes
                 WHERE deleted_at IS NOT NULL
                   AND julianday(deleted_at) < julianday('now', ?1)
                 LIMIT ?2
             )",
            rusqlite::params![cutoff_offset, TRASH_DELETE_CHUNK],
        )?;
        tx.commit()?;
        if n == 0 {
            break;
        }
        total += n as u64;
    }
    drop(conn);
    if total > 0 {
        let _ = wal_checkpoint(&db);
    }
    Ok(total)
}

fn fetch_note(conn: &rusqlite::Connection, id: &str) -> Result<Note> {
    let note = conn
        .query_row(
            "SELECT id, title, content_json, content_text, is_pinned, pinned_at, created_at, updated_at, deleted_at, folder_id
             FROM notes WHERE id = ?1",
            rusqlite::params![id],
            |row| {
                Ok(Note {
                    id: row.get("id")?,
                    title: row.get("title")?,
                    content_json: row.get("content_json")?,
                    content_text: row.get("content_text")?,
                    is_pinned: row.get::<_, i64>("is_pinned")? != 0,
                    pinned_at: row.get("pinned_at")?,
                    created_at: row.get("created_at")?,
                    updated_at: row.get("updated_at")?,
                    deleted_at: row.get("deleted_at")?,
                    folder_id: row.get("folder_id")?,
                })
            },
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => NoteZError::NotFound(id.to_string()),
            other => NoteZError::Database(other),
        })?;
    Ok(note)
}

/// Slim metadata fetch for the post-save IPC. Returns just what the
/// renderer needs to update its sidebar summary - no `content_json` and no
/// `content_text` echo. The backend is also the canonical source of the
/// `preview` (single-line, ellipsised, char-bounded), so the frontend's
/// summary stays consistent across save vs. refresh paths.
fn fetch_note_summary(conn: &rusqlite::Connection, id: &str) -> Result<NoteSummary> {
    let summary = conn
        .query_row(
            "SELECT id, title, content_text, is_pinned, pinned_at, updated_at, folder_id
             FROM notes WHERE id = ?1",
            rusqlite::params![id],
            |row| note_row_to_summary(conn, row),
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => NoteZError::NotFound(id.to_string()),
            other => NoteZError::Database(other),
        })?;
    Ok(summary)
}

fn clamp_limit(requested: Option<u32>, default: u32) -> u32 {
    requested.unwrap_or(default).clamp(1, MAX_PAGE_SIZE)
}

fn resolve_folder_scope(conn: &Connection, filter: &FolderFilter) -> Result<FolderScope> {
    match filter {
        FolderFilter::All => Ok(FolderScope::All),
        FolderFilter::Inbox => Ok(FolderScope::Inbox),
        FolderFilter::Folder { id, include_descendants } => {
            if *include_descendants {
                let ids = crate::commands::folders::resolve_descendants(conn, id)?;
                Ok(FolderScope::Set(ids))
            } else {
                Ok(FolderScope::Set(vec![id.clone()]))
            }
        }
    }
}

/// Build the folder-scoped clause to splice into a `WHERE deleted_at IS NULL`
/// query. Returns the SQL fragment (with `?` placeholders) and the matching
/// parameters - they're spliced into the caller's full param list in order.
fn folder_clause(scope: &FolderScope) -> (String, Vec<Value>) {
    match scope {
        FolderScope::All => (String::new(), Vec::new()),
        FolderScope::Inbox => (" AND folder_id IS NULL".to_string(), Vec::new()),
        // Empty set = "filter for a folder that doesn't exist". The `AND 0`
        // short-circuit is the simplest way to make the query return zero rows
        // without adding a special code path.
        FolderScope::Set(ids) if ids.is_empty() => (" AND 0".to_string(), Vec::new()),
        FolderScope::Set(ids) => {
            let placeholders = vec!["?"; ids.len()].join(",");
            let clause = format!(" AND folder_id IN ({})", placeholders);
            let params: Vec<Value> = ids.iter().map(|s| Value::from(s.clone())).collect();
            (clause, params)
        }
    }
}

fn load_pinned_summaries(conn: &Connection, scope: &FolderScope) -> Result<Vec<NoteSummary>> {
    let (folder_sql, folder_params) = folder_clause(scope);
    let sql = format!(
        "SELECT id, title, content_text, is_pinned, pinned_at, updated_at, folder_id
         FROM notes
         WHERE deleted_at IS NULL AND is_pinned = 1{folder_sql}
         ORDER BY pinned_at DESC, updated_at DESC
         LIMIT ?",
    );
    let mut params: Vec<Value> = folder_params;
    params.push(Value::from(MAX_PINNED));

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(params), |row| {
        note_row_to_summary(conn, row)
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

fn load_unpinned_page(
    conn: &Connection,
    cursor: Option<&NotesCursor>,
    limit: u32,
    scope: &FolderScope,
) -> Result<(Vec<NoteSummary>, bool)> {
    let (folder_sql, folder_params) = folder_clause(scope);
    let fetch = (limit + 1) as i64;
    let cursor_sql = if cursor.is_some() {
        " AND (updated_at, id) < (?, ?)"
    } else {
        ""
    };
    let sql = format!(
        "SELECT id, title, content_text, is_pinned, pinned_at, updated_at, folder_id
         FROM notes
         WHERE deleted_at IS NULL AND is_pinned = 0{folder_sql}{cursor_sql}
         ORDER BY updated_at DESC, id DESC
         LIMIT ?"
    );

    let mut params: Vec<Value> = folder_params;
    if let Some(c) = cursor {
        params.push(Value::from(c.updated_at.clone()));
        params.push(Value::from(c.id.clone()));
    }
    params.push(Value::from(fetch));

    let mut stmt = conn.prepare(&sql)?;
    Ok(collect_page(
        &mut stmt,
        rusqlite::params_from_iter(params),
        limit,
        |row| note_row_to_summary(conn, row),
    )?)
}
