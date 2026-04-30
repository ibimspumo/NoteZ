use crate::constants::{
    KNOWN_SETTING_KEYS, KNOWN_SETTING_PREFIXES, MAX_SETTING_KEY_BYTES, MAX_SETTING_VALUE_BYTES,
};
use crate::db::{now_iso, Db};
use crate::error::{NoteZError, Result};
use tauri::{AppHandle, State};

/// Validate that a settings key is one we know about. The allowlist is the
/// defense-in-depth boundary: the frontend already only writes well-known keys,
/// but an unrelated XSS or extension would otherwise inherit our `set_setting`
/// command and could overwrite e.g. shortcut bindings or trash retention.
fn is_allowed_key(key: &str) -> bool {
    if KNOWN_SETTING_KEYS.contains(&key) {
        return true;
    }
    KNOWN_SETTING_PREFIXES.iter().any(|p| key.starts_with(p))
}

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
pub fn set_setting(
    app: AppHandle,
    db: State<Db>,
    key: String,
    value: String,
) -> Result<()> {
    if key.len() > MAX_SETTING_KEY_BYTES {
        return Err(NoteZError::InvalidInput(format!(
            "setting key too long ({} bytes, max {MAX_SETTING_KEY_BYTES})",
            key.len()
        )));
    }
    if !is_allowed_key(&key) {
        return Err(NoteZError::InvalidInput(format!(
            "setting key not allowed: {key}"
        )));
    }
    if value.len() > MAX_SETTING_VALUE_BYTES {
        return Err(NoteZError::InvalidInput(format!(
            "setting value too large ({} bytes, max {MAX_SETTING_VALUE_BYTES})",
            value.len()
        )));
    }
    let conn = db.conn()?;
    let now = now_iso();
    conn.execute(
        "INSERT INTO settings (key, value, updated_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        rusqlite::params![key, value, now],
    )?;
    crate::events::emit_settings_changed(&app, &key);
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
