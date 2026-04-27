use crate::db::{now_iso, Db};
use crate::error::{NoteZError, Result};
use crate::models::Snapshot;
use tauri::State;
use uuid::Uuid;

#[tauri::command]
pub fn create_snapshot(
    db: State<Db>,
    note_id: String,
    is_manual: Option<bool>,
    manual_label: Option<String>,
) -> Result<Snapshot> {
    let conn = db.conn()?;
    let manual = is_manual.unwrap_or(false);

    let (title, content_json, content_text): (String, String, String) = conn
        .query_row(
            "SELECT title, content_json, content_text FROM notes WHERE id = ?1 AND deleted_at IS NULL",
            rusqlite::params![note_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => NoteZError::NotFound(note_id.clone()),
            other => NoteZError::Database(other),
        })?;

    if !manual {
        let last: Option<String> = conn
            .query_row(
                "SELECT content_json FROM snapshots WHERE note_id = ?1 ORDER BY created_at DESC LIMIT 1",
                rusqlite::params![note_id],
                |r| r.get(0),
            )
            .ok();
        if let Some(prev) = last {
            if prev == content_json {
                return Err(NoteZError::InvalidInput("no changes since last snapshot".into()));
            }
        }
    }

    let id = Uuid::new_v4().to_string();
    let now = now_iso();
    conn.execute(
        "INSERT INTO snapshots (id, note_id, title, content_json, content_text, created_at, is_manual, manual_label)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        rusqlite::params![
            id,
            note_id,
            title,
            content_json,
            content_text,
            now,
            manual as i64,
            manual_label
        ],
    )?;

    if !manual {
        conn.execute(
            "DELETE FROM snapshots
             WHERE note_id = ?1
               AND is_manual = 0
               AND id NOT IN (
                   SELECT id FROM snapshots
                   WHERE note_id = ?1 AND is_manual = 0
                   ORDER BY created_at DESC
                   LIMIT 50
               )",
            rusqlite::params![note_id],
        )?;
    }

    fetch_snapshot(&conn, &id)
}

#[tauri::command]
pub fn list_snapshots(db: State<Db>, note_id: String) -> Result<Vec<Snapshot>> {
    let conn = db.conn()?;
    let mut stmt = conn.prepare(
        "SELECT id, note_id, title, content_json, content_text, created_at, is_manual, manual_label
         FROM snapshots
         WHERE note_id = ?1
         ORDER BY created_at DESC",
    )?;
    let rows = stmt.query_map(rusqlite::params![note_id], |r| {
        Ok(Snapshot {
            id: r.get("id")?,
            note_id: r.get("note_id")?,
            title: r.get("title")?,
            content_json: r.get("content_json")?,
            content_text: r.get("content_text")?,
            created_at: r.get("created_at")?,
            is_manual: r.get::<_, i64>("is_manual")? != 0,
            manual_label: r.get("manual_label")?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

#[tauri::command]
pub fn restore_snapshot(db: State<Db>, snapshot_id: String) -> Result<()> {
    let mut conn = db.conn()?;
    let tx = conn.transaction()?;

    let (note_id, title, content_json, content_text): (String, String, String, String) = tx
        .query_row(
            "SELECT note_id, title, content_json, content_text FROM snapshots WHERE id = ?1",
            rusqlite::params![snapshot_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => NoteZError::NotFound(snapshot_id.clone()),
            other => NoteZError::Database(other),
        })?;

    let now = now_iso();
    tx.execute(
        "UPDATE notes SET title = ?1, content_json = ?2, content_text = ?3, updated_at = ?4 WHERE id = ?5",
        rusqlite::params![title, content_json, content_text, now, note_id],
    )?;
    tx.commit()?;
    Ok(())
}

fn fetch_snapshot(conn: &rusqlite::Connection, id: &str) -> Result<Snapshot> {
    let snap = conn
        .query_row(
            "SELECT id, note_id, title, content_json, content_text, created_at, is_manual, manual_label
             FROM snapshots WHERE id = ?1",
            rusqlite::params![id],
            |r| {
                Ok(Snapshot {
                    id: r.get("id")?,
                    note_id: r.get("note_id")?,
                    title: r.get("title")?,
                    content_json: r.get("content_json")?,
                    content_text: r.get("content_text")?,
                    created_at: r.get("created_at")?,
                    is_manual: r.get::<_, i64>("is_manual")? != 0,
                    manual_label: r.get("manual_label")?,
                })
            },
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => NoteZError::NotFound(id.to_string()),
            other => NoteZError::Database(other),
        })?;
    Ok(snap)
}
