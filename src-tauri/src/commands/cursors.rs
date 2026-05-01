//! Per-note caret-position persistence.
//!
//! Lives in its own table (migration v7) instead of the kitchen-sink `settings`
//! table. With 100k+ notes the old `cursor:<uuid>` keys would dominate the
//! settings table and slow `list_settings` proportionally to corpus size.
//!
//! Caret values are JSON-encoded `SerializedSelection` objects; the backend
//! treats them as opaque strings (the renderer parses/validates).
//!
//! FK CASCADE on note deletion drops orphan cursor rows automatically.

use crate::db::{now_iso, Db};
use crate::error::{NoteZError, Result};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::State;

/// Maximum cursor-blob length. A real `SerializedSelection` is <500 bytes;
/// this is just a defense-in-depth cap.
const MAX_CURSOR_BYTES: usize = 8 * 1024;

/// Drop cursor rows untouched for this many days. The exact caret position
/// inside a long-untouched note isn't worth the storage; on next open the
/// editor lands at the natural top-of-note default, which is what the user
/// would expect anyway.
const CURSOR_RETENTION_DAYS: i64 = 180;

/// Approximate budget between opportunistic prune passes. We don't run on
/// every `set_cursor` (would multiply per-keystroke caret persists by N);
/// we run roughly once per ~250 calls.
const CURSOR_PRUNE_INTERVAL_CALLS: u64 = 256;

static CURSOR_SET_CALLS_SINCE_PRUNE: AtomicU64 = AtomicU64::new(0);

#[tauri::command]
pub fn get_cursor(db: State<Db>, note_id: String) -> Result<Option<String>> {
    let conn = db.conn()?;
    let value: Option<String> = conn
        .query_row(
            "SELECT value FROM cursors WHERE note_id = ?1",
            rusqlite::params![note_id],
            |r| r.get(0),
        )
        .ok();
    Ok(value)
}

#[tauri::command]
pub fn set_cursor(db: State<Db>, note_id: String, value: String) -> Result<()> {
    if value.len() > MAX_CURSOR_BYTES {
        return Err(NoteZError::InvalidInput(format!(
            "cursor blob too large ({} bytes, max {MAX_CURSOR_BYTES})",
            value.len()
        )));
    }
    let conn = db.conn()?;
    // Note must exist and not be soft-deleted - we don't want to leave
    // dangling cursors on trashed notes (they'd be FK-cascaded out anyway
    // on hard delete, but we shouldn't create new ones either).
    let exists: i64 = conn
        .query_row(
            "SELECT COUNT(1) FROM notes WHERE id = ?1 AND deleted_at IS NULL",
            rusqlite::params![note_id],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if exists == 0 {
        // Quietly succeed - cursor for a nonexistent note is a no-op rather
        // than an error, mirroring how the renderer's editor.tsx persists
        // best-effort.
        return Ok(());
    }
    let now = now_iso();
    conn.execute(
        "INSERT INTO cursors (note_id, value, updated_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(note_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        rusqlite::params![note_id, value, now],
    )?;

    // Opportunistic prune. Runs ~1 in 256 calls so per-keystroke cost stays
    // amortised down to nothing, but a long-running session still GCs stale
    // rows. The prune itself uses the partial-index-friendly julianday
    // comparator and is bounded by however many rows exceed retention -
    // typically zero in steady state.
    let prev = CURSOR_SET_CALLS_SINCE_PRUNE.fetch_add(1, Ordering::Relaxed);
    if prev % CURSOR_PRUNE_INTERVAL_CALLS == 0 {
        let _ = conn.execute(
            "DELETE FROM cursors
             WHERE julianday(updated_at) < julianday('now', ?1)",
            rusqlite::params![format!("-{} days", CURSOR_RETENTION_DAYS)],
        );
    }
    Ok(())
}
