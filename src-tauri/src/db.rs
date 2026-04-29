use crate::constants::{DB_BUSY_TIMEOUT_SECS, DB_POOL_SIZE, PREVIEW_MAX_CHARS};
use crate::error::Result;
use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::Connection;
use std::path::Path;
use std::sync::Arc;

pub type DbPool = Pool<SqliteConnectionManager>;

#[derive(Clone)]
pub struct Db {
    pub pool: Arc<DbPool>,
    /// Absolute path to the on-disk asset directory (`<app_data>/assets`).
    /// Stable for the lifetime of the app.
    pub assets_dir: std::path::PathBuf,
}

impl Db {
    pub fn open(path: impl AsRef<Path>, assets_dir: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref().to_path_buf();
        let assets_dir = assets_dir.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::create_dir_all(&assets_dir)?;

        // Bootstrap pass:
        //   - ensure page_size is 8192 (required before any tables exist; existing DBs are
        //     migrated via VACUUM, which cannot run inside a transaction or under WAL)
        //   - turn WAL on once, on a single connection, before the r2d2 pool builds others
        //     in parallel (avoids "database is locked" races during bootstrap)
        //
        // WAL re-enable is unconditional: if the user kills the app between the page_size
        // VACUUM and the WAL pragma, the DB stays in DELETE mode forever - running this
        // on every launch is idempotent and self-healing.
        {
            let bootstrap = Connection::open(&path)?;
            bootstrap.busy_timeout(std::time::Duration::from_secs(DB_BUSY_TIMEOUT_SECS))?;

            let current_page_size: i64 =
                bootstrap.query_row("PRAGMA page_size", [], |r| r.get(0))?;
            if current_page_size != 8192 {
                // VACUUM requires journal_mode != WAL.
                bootstrap.pragma_update(None, "journal_mode", "DELETE")?;
                bootstrap.execute_batch("PRAGMA page_size = 8192; VACUUM;")?;
            }
            bootstrap.pragma_update(None, "journal_mode", "WAL")?;
        }

        let manager = SqliteConnectionManager::file(&path).with_init(|c| {
            c.busy_timeout(std::time::Duration::from_secs(DB_BUSY_TIMEOUT_SECS))?;
            c.execute_batch(
                "PRAGMA synchronous=NORMAL;
                 PRAGMA foreign_keys=ON;
                 PRAGMA temp_store=MEMORY;
                 PRAGMA mmap_size=268435456;
                 PRAGMA cache_size=-65536;
                 PRAGMA wal_autocheckpoint=1000;
                 PRAGMA journal_size_limit=67108864;",
            )
        });
        let pool = Pool::builder().max_size(DB_POOL_SIZE).build(manager)?;

        let db = Self {
            pool: Arc::new(pool),
            assets_dir,
        };
        db.migrate()?;
        Ok(db)
    }

    pub fn conn(&self) -> Result<r2d2::PooledConnection<SqliteConnectionManager>> {
        Ok(self.pool.get()?)
    }

    fn migrate(&self) -> Result<()> {
        let mut conn = self.conn()?;
        let current: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;

        let migrations: &[(i64, &str)] = &[
            (1, MIGRATION_001),
            (2, MIGRATION_002),
            (3, MIGRATION_003),
        ];

        let tx = conn.transaction()?;
        for (version, sql) in migrations {
            if *version > current {
                tracing::info!("applying migration v{}", version);
                tx.execute_batch(sql)?;
                tx.execute_batch(&format!("PRAGMA user_version = {}", version))?;
            }
        }
        tx.commit()?;
        Ok(())
    }
}

const MIGRATION_001: &str = r#"
CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    content_json TEXT NOT NULL DEFAULT '{}',
    content_text TEXT NOT NULL DEFAULT '',
    is_pinned INTEGER NOT NULL DEFAULT 0,
    pinned_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_notes_updated_at ON notes(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_notes_deleted_at ON notes(deleted_at);
CREATE INDEX IF NOT EXISTS idx_notes_pinned ON notes(is_pinned, pinned_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
    title,
    content_text,
    content='notes',
    content_rowid='rowid',
    tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
    INSERT INTO notes_fts(rowid, title, content_text)
    VALUES (new.rowid, new.title, new.content_text);
END;

CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, title, content_text)
    VALUES ('delete', old.rowid, old.title, old.content_text);
END;

CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, title, content_text)
    VALUES ('delete', old.rowid, old.title, old.content_text);
    INSERT INTO notes_fts(rowid, title, content_text)
    VALUES (new.rowid, new.title, new.content_text);
END;

CREATE TABLE IF NOT EXISTS snapshots (
    id TEXT PRIMARY KEY,
    note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    content_json TEXT NOT NULL,
    content_text TEXT NOT NULL,
    created_at TEXT NOT NULL,
    is_manual INTEGER NOT NULL DEFAULT 0,
    manual_label TEXT
);

CREATE INDEX IF NOT EXISTS idx_snapshots_note ON snapshots(note_id, created_at DESC);

CREATE TABLE IF NOT EXISTS mentions (
    source_note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    target_note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (source_note_id, target_note_id)
);

CREATE INDEX IF NOT EXISTS idx_mentions_target ON mentions(target_note_id);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
"#;

// v2:
//   - rebuild FTS5 with prefix='2 3 4' so trailing-* queries don't scan the full term list
//   - explicitly drop+recreate the FTS triggers so the dependency between the FTS schema
//     and its maintenance triggers is captured in the same migration (otherwise a future
//     FTS column change would silently desync from the v1-defined triggers)
//   - add a partial index for the active-notes listing path (skips trash rows entirely)
//   - drop the now-redundant full updated_at index
//   - add a partial index for the pinned-list query
//   - add an explicit index on notes.created_at (used by upcoming "sort by created" UIs)
//   - make the FTS update trigger conditional on title/content actually changing -
//     toggle_pin() and other metadata-only updates no longer cause an FTS rebuild
//   - add the assets table for image / attachment storage with content-addressed dedup
const MIGRATION_002: &str = r#"
DROP TRIGGER IF EXISTS notes_ai;
DROP TRIGGER IF EXISTS notes_ad;
DROP TRIGGER IF EXISTS notes_au;
DROP TABLE IF EXISTS notes_fts;

CREATE VIRTUAL TABLE notes_fts USING fts5(
    title,
    content_text,
    content='notes',
    content_rowid='rowid',
    tokenize='unicode61 remove_diacritics 2',
    prefix='2 3 4'
);

INSERT INTO notes_fts(rowid, title, content_text)
SELECT rowid, title, content_text FROM notes;

CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN
    INSERT INTO notes_fts(rowid, title, content_text)
    VALUES (new.rowid, new.title, new.content_text);
END;

CREATE TRIGGER notes_ad AFTER DELETE ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, title, content_text)
    VALUES ('delete', old.rowid, old.title, old.content_text);
END;

-- Conditional update: only rebuild the FTS row when the indexed columns actually
-- change. This makes pin toggles, soft-deletes, and any other metadata-only
-- writes free w.r.t. FTS - a real win when a user is rapidly pinning/unpinning.
CREATE TRIGGER notes_au AFTER UPDATE OF title, content_text ON notes
WHEN old.title IS NOT new.title OR old.content_text IS NOT new.content_text
BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, title, content_text)
    VALUES ('delete', old.rowid, old.title, old.content_text);
    INSERT INTO notes_fts(rowid, title, content_text)
    VALUES (new.rowid, new.title, new.content_text);
END;

DROP INDEX IF EXISTS idx_notes_updated_at;
CREATE INDEX IF NOT EXISTS idx_notes_active_updated
    ON notes(updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_notes_trash_deleted
    ON notes(deleted_at DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_notes_active_pinned
    ON notes(pinned_at DESC) WHERE deleted_at IS NULL AND is_pinned = 1;
CREATE INDEX IF NOT EXISTS idx_notes_created_at ON notes(created_at DESC);

CREATE TABLE IF NOT EXISTS assets (
    id TEXT PRIMARY KEY,                  -- sha256 hex of bytes
    mime TEXT NOT NULL,
    ext TEXT NOT NULL,                    -- file extension without dot
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    blurhash TEXT,
    byte_size INTEGER NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_assets_created_at ON assets(created_at DESC);
"#;

// v3: AI call ledger for OpenRouter integration. Every call (success or failure)
// gets a row with token counts, USD cost, and a loose note_id reference (no FK
// CASCADE - call history must outlive a deleted note so spend stays auditable).
const MIGRATION_003: &str = r#"
CREATE TABLE IF NOT EXISTS ai_calls (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    model TEXT NOT NULL,
    purpose TEXT NOT NULL,
    note_id TEXT,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    error TEXT
);

CREATE INDEX IF NOT EXISTS idx_ai_calls_created_at ON ai_calls(created_at DESC);
"#;

pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// Force a WAL checkpoint with TRUNCATE - merge the WAL back into the main DB
/// and shrink it to zero. Call after a bulk operation that produced a large
/// WAL (`empty_trash`, `dev_delete_generated_notes`, big migrations) so the
/// WAL doesn't keep eating disk between auto-checkpoints.
///
/// Best-effort: the result is logged but never bubbles up - failure means the
/// WAL stays large until the next auto-checkpoint, which is harmless.
pub fn wal_checkpoint(db: &Db) -> Result<()> {
    let conn = db.conn()?;
    if let Err(e) = conn.pragma_update(None, "wal_checkpoint", "TRUNCATE") {
        tracing::warn!("wal_checkpoint(TRUNCATE) failed: {e}");
    }
    Ok(())
}

pub fn note_row_to_summary(
    _conn: &Connection,
    row: &rusqlite::Row,
) -> rusqlite::Result<crate::models::NoteSummary> {
    let content_text: String = row.get("content_text")?;
    let preview = make_preview(&content_text, PREVIEW_MAX_CHARS);
    Ok(crate::models::NoteSummary {
        id: row.get("id")?,
        title: row.get("title")?,
        preview,
        is_pinned: row.get::<_, i64>("is_pinned")? != 0,
        pinned_at: row.get("pinned_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub fn make_preview(content_text: &str, max_len: usize) -> String {
    let cleaned: String = content_text
        .split('\n')
        .map(|line| line.trim())
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(" · ");
    if cleaned.chars().count() <= max_len {
        cleaned
    } else {
        let truncated: String = cleaned.chars().take(max_len).collect();
        format!("{}…", truncated)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn make_preview_collapses_newlines_to_dots() {
        let text = "First line\nSecond line\n\nThird line";
        assert_eq!(make_preview(text, 100), "First line · Second line · Third line");
    }

    #[test]
    fn make_preview_skips_blank_lines() {
        let text = "\n\nFirst\n\n  \nSecond\n";
        assert_eq!(make_preview(text, 100), "First · Second");
    }

    #[test]
    fn make_preview_truncates_with_ellipsis() {
        let text = "x".repeat(200);
        let preview = make_preview(&text, 50);
        assert_eq!(preview.chars().count(), 51); // 50 chars + ellipsis
        assert!(preview.ends_with('…'));
    }

    #[test]
    fn make_preview_handles_unicode_boundaries() {
        // 4-char-wide emoji should not split mid-codepoint.
        let text = "😀".repeat(60);
        let preview = make_preview(&text, 10);
        assert_eq!(preview.chars().count(), 11); // 10 emoji + ellipsis
    }

    #[test]
    fn make_preview_is_short_circuit_when_under_limit() {
        let text = "Short";
        assert_eq!(make_preview(text, 100), "Short");
    }
}
