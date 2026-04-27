use crate::db::{note_row_to_summary, now_iso, Db};
use crate::error::{NoteZError, Result};
use crate::models::{
    Note, NoteSummary, NotesCursor, NotesPage, TrashCursor, TrashPage, UpdateNoteInput,
};
use rusqlite::Connection;
use tauri::State;
use uuid::Uuid;

/// Hard cap to keep IPC frames small even if a buggy caller asks for the moon.
/// 500 rows ≈ 80 KB of NoteSummary JSON — that's our budget per RTT.
const MAX_PAGE_SIZE: u32 = 500;

#[tauri::command]
pub fn create_note(db: State<Db>) -> Result<Note> {
    let conn = db.conn()?;
    let id = Uuid::new_v4().to_string();
    let now = now_iso();
    conn.execute(
        "INSERT INTO notes (id, title, content_json, content_text, created_at, updated_at)
         VALUES (?1, '', '{}', '', ?2, ?2)",
        rusqlite::params![id, now],
    )?;
    fetch_note(&conn, &id)
}

#[tauri::command]
pub fn get_note(db: State<Db>, id: String) -> Result<Note> {
    let conn = db.conn()?;
    fetch_note(&conn, &id)
}

#[tauri::command]
pub fn update_note(db: State<Db>, input: UpdateNoteInput) -> Result<Note> {
    let mut conn = db.conn()?;
    let tx = conn.transaction()?;

    let now = now_iso();
    let updated = tx.execute(
        "UPDATE notes SET title = ?1, content_json = ?2, content_text = ?3, updated_at = ?4
         WHERE id = ?5 AND deleted_at IS NULL",
        rusqlite::params![input.title, input.content_json, input.content_text, now, input.id],
    )?;
    if updated == 0 {
        return Err(NoteZError::NotFound(input.id.clone()));
    }

    tx.execute("DELETE FROM mentions WHERE source_note_id = ?1", rusqlite::params![input.id])?;
    for target in &input.mention_target_ids {
        if target == &input.id {
            continue;
        }
        let exists: i64 = tx
            .query_row(
                "SELECT COUNT(1) FROM notes WHERE id = ?1 AND deleted_at IS NULL",
                rusqlite::params![target],
                |r| r.get(0),
            )
            .unwrap_or(0);
        if exists > 0 {
            tx.execute(
                "INSERT OR IGNORE INTO mentions (source_note_id, target_note_id, created_at) VALUES (?1, ?2, ?3)",
                rusqlite::params![input.id, target, now],
            )?;
        }
    }

    tx.commit()?;
    fetch_note(&conn, &input.id)
}

/// Paginated active-notes listing.
///
/// First page (cursor=None) returns pinned items in full — pinned counts are
/// bounded by user behaviour so we don't paginate them. Following pages return
/// only unpinned items, ordered by `updated_at DESC, id DESC` for cursor stability
/// when several notes share the same timestamp.
#[tauri::command]
pub fn list_notes(
    db: State<Db>,
    cursor: Option<NotesCursor>,
    limit: Option<u32>,
) -> Result<NotesPage> {
    let conn = db.conn()?;
    let limit = clamp_limit(limit, 100);

    // Pinned notes only on the first page.
    let pinned = if cursor.is_none() {
        load_pinned_summaries(&conn)?
    } else {
        Vec::new()
    };

    let items = load_unpinned_page(&conn, cursor.as_ref(), limit + 1)?;

    let (items, next_cursor) = split_page(items, limit, |last| NotesCursor {
        updated_at: last.updated_at.clone(),
        id: last.id.clone(),
    });

    Ok(NotesPage { pinned, items, next_cursor })
}

#[tauri::command]
pub fn list_trash(
    db: State<Db>,
    cursor: Option<TrashCursor>,
    limit: Option<u32>,
) -> Result<TrashPage> {
    let conn = db.conn()?;
    let limit = clamp_limit(limit, 100);

    // Trash uses a separate cursor (deleted_at instead of updated_at).
    // The partial index `idx_notes_trash_deleted` makes this a covered range scan.
    let rows: Vec<(NoteSummary, String)> = if let Some(c) = cursor.as_ref() {
        let mut stmt = conn.prepare(
            "SELECT id, title, content_text, is_pinned, pinned_at, updated_at, deleted_at
             FROM notes
             WHERE deleted_at IS NOT NULL
               AND (deleted_at, id) < (?1, ?2)
             ORDER BY deleted_at DESC, id DESC
             LIMIT ?3",
        )?;
        let mapped = stmt.query_map(
            rusqlite::params![c.deleted_at, c.id, (limit + 1) as i64],
            |row| {
                let summary = note_row_to_summary(&conn, row)?;
                let deleted_at: String = row.get("deleted_at")?;
                Ok((summary, deleted_at))
            },
        )?;
        let collected: rusqlite::Result<Vec<_>> = mapped.collect();
        collected?
    } else {
        let mut stmt = conn.prepare(
            "SELECT id, title, content_text, is_pinned, pinned_at, updated_at, deleted_at
             FROM notes
             WHERE deleted_at IS NOT NULL
             ORDER BY deleted_at DESC, id DESC
             LIMIT ?1",
        )?;
        let mapped = stmt.query_map(rusqlite::params![(limit + 1) as i64], |row| {
            let summary = note_row_to_summary(&conn, row)?;
            let deleted_at: String = row.get("deleted_at")?;
            Ok((summary, deleted_at))
        })?;
        let collected: rusqlite::Result<Vec<_>> = mapped.collect();
        collected?
    };

    let has_more = rows.len() > limit as usize;
    let items_with_cursor: Vec<(NoteSummary, String)> =
        rows.into_iter().take(limit as usize).collect();

    let next_cursor = if has_more {
        items_with_cursor.last().map(|(s, deleted_at)| TrashCursor {
            deleted_at: deleted_at.clone(),
            id: s.id.clone(),
        })
    } else {
        None
    };

    let items = items_with_cursor.into_iter().map(|(s, _)| s).collect();
    Ok(TrashPage { items, next_cursor })
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

#[tauri::command]
pub fn empty_trash(db: State<Db>) -> Result<u64> {
    let conn = db.conn()?;
    let n = conn.execute("DELETE FROM notes WHERE deleted_at IS NOT NULL", [])?;
    Ok(n as u64)
}

#[tauri::command]
pub fn purge_old_trash(db: State<Db>, days: u32) -> Result<u64> {
    let conn = db.conn()?;
    let n = conn.execute(
        "DELETE FROM notes
         WHERE deleted_at IS NOT NULL
           AND deleted_at < datetime('now', ?1)",
        rusqlite::params![format!("-{} days", days)],
    )?;
    Ok(n as u64)
}

fn fetch_note(conn: &rusqlite::Connection, id: &str) -> Result<Note> {
    let note = conn
        .query_row(
            "SELECT id, title, content_json, content_text, is_pinned, pinned_at, created_at, updated_at, deleted_at
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
                })
            },
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => NoteZError::NotFound(id.to_string()),
            other => NoteZError::Database(other),
        })?;
    Ok(note)
}

fn clamp_limit(requested: Option<u32>, default: u32) -> u32 {
    requested.unwrap_or(default).clamp(1, MAX_PAGE_SIZE)
}

/// Hard ceiling on pinned items returned to the frontend. Pinned counts are
/// bounded by user behaviour in practice — but a misuse (or a sync bug from a
/// future feature) shouldn't be able to dump 100k summaries into the IPC.
const MAX_PINNED: i64 = 200;

fn load_pinned_summaries(conn: &Connection) -> Result<Vec<NoteSummary>> {
    let mut stmt = conn.prepare(
        "SELECT id, title, content_text, is_pinned, pinned_at, updated_at
         FROM notes
         WHERE deleted_at IS NULL AND is_pinned = 1
         ORDER BY pinned_at DESC, updated_at DESC
         LIMIT ?1",
    )?;
    let rows = stmt.query_map(rusqlite::params![MAX_PINNED], |row| {
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
    limit_plus_one: u32,
) -> Result<Vec<NoteSummary>> {
    let rows = if let Some(c) = cursor {
        let mut stmt = conn.prepare(
            "SELECT id, title, content_text, is_pinned, pinned_at, updated_at
             FROM notes
             WHERE deleted_at IS NULL
               AND is_pinned = 0
               AND (updated_at, id) < (?1, ?2)
             ORDER BY updated_at DESC, id DESC
             LIMIT ?3",
        )?;
        let mapped = stmt.query_map(
            rusqlite::params![c.updated_at, c.id, limit_plus_one as i64],
            |row| note_row_to_summary(conn, row),
        )?;
        let collected: rusqlite::Result<Vec<_>> = mapped.collect();
        collected?
    } else {
        let mut stmt = conn.prepare(
            "SELECT id, title, content_text, is_pinned, pinned_at, updated_at
             FROM notes
             WHERE deleted_at IS NULL
               AND is_pinned = 0
             ORDER BY updated_at DESC, id DESC
             LIMIT ?1",
        )?;
        let mapped = stmt.query_map(rusqlite::params![limit_plus_one as i64], |row| {
            note_row_to_summary(conn, row)
        })?;
        let collected: rusqlite::Result<Vec<_>> = mapped.collect();
        collected?
    };
    Ok(rows)
}

fn split_page<F>(
    mut rows: Vec<NoteSummary>,
    limit: u32,
    make_cursor: F,
) -> (Vec<NoteSummary>, Option<NotesCursor>)
where
    F: Fn(&NoteSummary) -> NotesCursor,
{
    if rows.len() > limit as usize {
        rows.truncate(limit as usize);
        let cursor = rows.last().map(&make_cursor);
        (rows, cursor)
    } else {
        (rows, None)
    }
}
