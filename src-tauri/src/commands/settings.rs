use crate::db::{now_iso, Db};
use crate::error::Result;
use tauri::State;

#[tauri::command]
pub fn get_setting(db: State<Db>, key: String) -> Result<Option<String>> {
    let conn = db.conn()?;
    let value: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            rusqlite::params![key],
            |r| r.get(0),
        )
        .ok();
    Ok(value)
}

#[tauri::command]
pub fn set_setting(db: State<Db>, key: String, value: String) -> Result<()> {
    let conn = db.conn()?;
    let now = now_iso();
    conn.execute(
        "INSERT INTO settings (key, value, updated_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        rusqlite::params![key, value, now],
    )?;
    Ok(())
}

#[tauri::command]
pub fn list_settings(db: State<Db>) -> Result<Vec<(String, String)>> {
    let conn = db.conn()?;
    let mut stmt = conn.prepare("SELECT key, value FROM settings ORDER BY key")?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}
