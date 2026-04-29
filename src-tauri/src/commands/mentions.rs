use crate::constants::PREVIEW_MAX_CHARS;
use crate::db::Db;
use crate::error::Result;
use crate::models::NoteSummary;
use tauri::State;

#[tauri::command]
pub fn list_backlinks(db: State<Db>, note_id: String) -> Result<Vec<NoteSummary>> {
    let conn = db.conn()?;
    let mut stmt = conn.prepare(
        "SELECT n.id, n.title, n.content_text, n.is_pinned, n.pinned_at, n.updated_at
         FROM mentions m
         JOIN notes n ON n.id = m.source_note_id
         WHERE m.target_note_id = ?1 AND n.deleted_at IS NULL
         ORDER BY n.updated_at DESC",
    )?;
    let rows = stmt.query_map(rusqlite::params![note_id], |row| {
        let content_text: String = row.get("content_text")?;
        Ok(NoteSummary {
            id: row.get("id")?,
            title: row.get("title")?,
            preview: crate::db::make_preview(&content_text, PREVIEW_MAX_CHARS),
            is_pinned: row.get::<_, i64>("is_pinned")? != 0,
            pinned_at: row.get("pinned_at")?,
            updated_at: row.get("updated_at")?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}
