use crate::constants::PREVIEW_MAX_CHARS;
use crate::db::Db;
use crate::error::Result;
use crate::models::{MentionTargetStatus, NoteSummary};
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

/// Resolve the live status (`alive` / `trashed` / `missing`) for a batch of
/// mention target IDs. Used by the editor to paint broken/trashed mention
/// pills - persisted `__title` is kept as-is, but the visual state reflects
/// reality. The IDs come from a single editor's mention set (realistically
/// <50), so the dynamic `IN (?, ?, ...)` placeholder list stays well below
/// SQLite's 32K-parameter cap.
#[tauri::command]
pub fn get_mention_status_bulk(
    db: State<Db>,
    ids: Vec<String>,
) -> Result<Vec<MentionTargetStatus>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let conn = db.conn()?;
    let placeholders = (1..=ids.len()).map(|i| format!("?{i}")).collect::<Vec<_>>().join(",");
    let sql = format!(
        "SELECT id, deleted_at IS NOT NULL AS is_trashed
         FROM notes
         WHERE id IN ({placeholders})"
    );
    let mut stmt = conn.prepare(&sql)?;
    let params: Vec<&dyn rusqlite::ToSql> =
        ids.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
    let rows = stmt.query_map(params.as_slice(), |row| {
        let id: String = row.get("id")?;
        let trashed: i64 = row.get("is_trashed")?;
        Ok((id, trashed != 0))
    })?;
    let mut by_id = std::collections::HashMap::new();
    for r in rows {
        let (id, trashed) = r?;
        by_id.insert(id, trashed);
    }
    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        let status = match by_id.get(&id) {
            Some(true) => "trashed",
            Some(false) => "alive",
            None => "missing",
        };
        out.push(MentionTargetStatus { id, status: status.to_string() });
    }
    Ok(out)
}
