use crate::db::{note_row_to_summary, now_iso, Db};
use crate::error::{NoteZError, Result};
use crate::models::{Note, NoteSummary, UpdateNoteInput};
use tauri::State;
use uuid::Uuid;

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

#[tauri::command]
pub fn list_notes(db: State<Db>, include_deleted: Option<bool>) -> Result<Vec<NoteSummary>> {
    let conn = db.conn()?;
    let include_deleted = include_deleted.unwrap_or(false);

    let sql = if include_deleted {
        "SELECT id, title, content_text, is_pinned, pinned_at, updated_at
         FROM notes
         ORDER BY is_pinned DESC, COALESCE(pinned_at, updated_at) DESC, updated_at DESC"
    } else {
        "SELECT id, title, content_text, is_pinned, pinned_at, updated_at
         FROM notes
         WHERE deleted_at IS NULL
         ORDER BY is_pinned DESC, COALESCE(pinned_at, updated_at) DESC, updated_at DESC"
    };

    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map([], |row| note_row_to_summary(&conn, row))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

#[tauri::command]
pub fn list_trash(db: State<Db>) -> Result<Vec<NoteSummary>> {
    let conn = db.conn()?;
    let mut stmt = conn.prepare(
        "SELECT id, title, content_text, is_pinned, pinned_at, updated_at
         FROM notes
         WHERE deleted_at IS NOT NULL
         ORDER BY deleted_at DESC",
    )?;
    let rows = stmt.query_map([], |row| note_row_to_summary(&conn, row))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
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
